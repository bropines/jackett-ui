// Package store keeps the jackett-ui settings file (DATA_DIR/jackett-ui.json).
//
// The file is created with mode 0600 and always written atomically (temp file
// in the same directory, fsync, rename). Readers get deep copies, writers go
// through Update, which serialises changes and only swaps the in-memory copy
// after the file was written successfully.
//
// Format version 2 (docs/spec-v0.3-users.md) adds users, API tokens, invites
// and independently switchable login methods. A version 1 file is migrated
// on Open (see migrate.go); the original is kept as jackett-ui.json.v1.bak.
package store

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// FileName is the settings file name inside DATA_DIR.
const FileName = "jackett-ui.json"

// BackupV1Name is the copy of a version 1 file kept by the migration.
const BackupV1Name = FileName + ".v1.bak"

// CurrentVersion is the settings file format version.
const CurrentVersion = 3

// BackupV2Name is the copy of a version 2 file kept by the v2 → v3 migration.
const BackupV2Name = FileName + ".v2.bak"

// SessionKeySize is the size of the HMAC key for sessions.
const SessionKeySize = 32

// Roles.
const (
	RoleViewer = "viewer"
	RoleEditor = "editor"
	RoleAdmin  = "admin"
)

// Settings is the content of the settings file.
type Settings struct {
	Version    int    `json:"version"`
	SessionKey []byte `json:"sessionKey"` // base64 in JSON
	// AuthEpoch ends everybody's sessions when bumped.
	AuthEpoch uint64 `json:"authEpoch"`
	Auth      Auth   `json:"auth"`
	// PublicURL and SessionTTL are optional; env (PUBLIC_URL, SESSION_TTL) wins.
	PublicURL  string `json:"publicUrl,omitempty"`
	SessionTTL string `json:"sessionTtl,omitempty"`

	// Onboarded: the first-login wizard was finished or skipped (v0.4).
	Onboarded bool `json:"onboarded,omitempty"`

	Users   []User   `json:"users"`
	Tokens  []Token  `json:"tokens"`
	Invites []Invite `json:"invites"`
}

// Methods are the independently switchable login methods.
type Methods struct {
	Password bool `json:"password"`
	OIDC     bool `json:"oidc"`
	Google   bool `json:"google"`
	GitHub   bool `json:"github"`
	Header   bool `json:"header"`
	Passkey  bool `json:"passkey"`
}

// Get returns the switch for method id (password, oidc, google, github, header, passkey).
func (m Methods) Get(id string) bool {
	switch id {
	case "password":
		return m.Password
	case "oidc":
		return m.OIDC
	case "google":
		return m.Google
	case "github":
		return m.GitHub
	case "header":
		return m.Header
	case "passkey":
		return m.Passkey
	}
	return false
}

// Ptr returns a pointer to the switch for method id, nil if unknown.
func (m *Methods) Ptr(id string) *bool {
	switch id {
	case "password":
		return &m.Password
	case "oidc":
		return &m.OIDC
	case "google":
		return &m.Google
	case "github":
		return &m.GitHub
	case "header":
		return &m.Header
	case "passkey":
		return &m.Passkey
	}
	return nil
}

// AutoProvision: create accounts for allow-listed external logins.
type AutoProvision struct {
	Enabled bool   `json:"enabled"`
	Role    string `json:"role"`
}

// Auth holds the stored authentication settings.
type Auth struct {
	Methods Methods `json:"methods"`
	// Disabled: no login at all, everyone is an anonymous admin.
	Disabled      bool          `json:"disabled"`
	AutoProvision AutoProvision `json:"autoProvision"`
	// AllowedEmails applies to every external provider; GitHubUsers to
	// GitHub logins; they gate auto-provisioning. AdminEmails: auto-provisioned
	// users with these (verified) e-mails become admins.
	AllowedEmails []string  `json:"allowedEmails"`
	AdminEmails   []string  `json:"adminEmails"`
	GitHubUsers   []string  `json:"githubUsers"`
	Providers     Providers `json:"providers"`
	Header        Header    `json:"header"`
}

// Providers holds the external login providers.
type Providers struct {
	OIDC   Provider `json:"oidc"`
	Google Provider `json:"google"`
	GitHub Provider `json:"github"`
}

// Get returns a pointer to the provider with id (oidc, google, github).
func (p *Providers) Get(id string) *Provider {
	switch id {
	case "oidc":
		return &p.OIDC
	case "google":
		return &p.Google
	case "github":
		return &p.GitHub
	}
	return nil
}

// Provider holds one provider's client settings. Issuer, ProviderName,
// Scopes, AllowedGroups and GroupsClaim are used by the generic oidc
// provider only.
type Provider struct {
	Issuer        string   `json:"issuer,omitempty"`
	ClientID      string   `json:"clientId"`
	ClientSecret  string   `json:"clientSecret"`
	ProviderName  string   `json:"providerName,omitempty"`
	Scopes        string   `json:"scopes,omitempty"`
	AllowedGroups []string `json:"allowedGroups,omitempty"`
	GroupsClaim   string   `json:"groupsClaim,omitempty"`
	// AllowUnverifiedEmail (oidc only): accept email_verified=false for AllowedEmails.
	AllowUnverifiedEmail bool `json:"allowUnverifiedEmail,omitempty"`
	// VerifiedHash is the hash of the issuer/client/secret/scopes combination
	// that passed the settings "test login". The provider is verified when
	// the hash of the current values equals it.
	VerifiedHash string `json:"verifiedHash,omitempty"`
}

// Header holds the stored trusted-header settings.
type Header struct {
	Name    string   `json:"name"`
	Trusted []string `json:"trusted"`
}

// User is a panel account.
type User struct {
	ID       string `json:"id"`
	Username string `json:"username"` // lower-case, unique
	Name     string `json:"name"`
	Role     string `json:"role"`
	// Email is optional, lower-case, unique when set.
	Email string `json:"email,omitempty"`
	// PasswordHash is bcrypt; "" = no password. The Bootstrap user gets
	// its password from AUTH_PASSWORD[_HASH] instead (never stored).
	PasswordHash string `json:"passwordHash,omitempty"`
	// Bootstrap: the initial admin whose password is AUTH_PASSWORD[_HASH].
	Bootstrap bool `json:"bootstrap,omitempty"`
	// Onboard: show this user the first-login wizard on the next login
	// (set by `jackett-ui reset-password` for admins).
	Onboard    bool       `json:"onboard,omitempty"`
	Disabled   bool       `json:"disabled"`
	Identities []Identity `json:"identities"`
	// WebAuthnID is the WebAuthn user handle (random, set with the first passkey).
	WebAuthnID []byte    `json:"webauthnId,omitempty"`
	Passkeys   []Passkey `json:"passkeys,omitempty"`
	// Epoch is bumped on password change, role change, disable and
	// "log out everywhere"; sessions carry it.
	Epoch       uint64     `json:"epoch"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt,omitempty"`
}

// Identity is an external account linked to a user. The key is
// (Provider, Issuer, Subject).
type Identity struct {
	Provider string    `json:"provider"`
	Issuer   string    `json:"issuer"`
	Subject  string    `json:"subject"`
	Label    string    `json:"label"`
	LinkedAt time.Time `json:"linkedAt"`
}

// Passkey is a WebAuthn credential of a user.
type Passkey struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	CredentialID    []byte     `json:"credentialId"`
	PublicKey       []byte     `json:"publicKey"`
	AttestationType string     `json:"attestationType,omitempty"`
	AAGUID          []byte     `json:"aaguid,omitempty"`
	SignCount       uint32     `json:"signCount"`
	Transports      []string   `json:"transports,omitempty"`
	Attachment      string     `json:"attachment,omitempty"`
	BackupEligible  bool       `json:"backupEligible,omitempty"`
	BackupState     bool       `json:"backupState,omitempty"`
	CloneWarning    bool       `json:"cloneWarning,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	LastUsedAt      *time.Time `json:"lastUsedAt,omitempty"`
}

// Token is a personal API token (stored hashed).
type Token struct {
	ID         string     `json:"id"`
	UserID     string     `json:"userId"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Hash       string     `json:"hash"` // sha256 hex of the token
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	LastUsedIP string     `json:"lastUsedIp,omitempty"`
	ExpiresAt  *time.Time `json:"expiresAt"`
}

// Invite is a pending one-time invitation (token stored hashed).
type Invite struct {
	ID        string    `json:"id"`
	Hash      string    `json:"hash"`
	Role      string    `json:"role"`
	Name      string    `json:"name"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func cloneTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := *t
	return &v
}

// Clone returns a deep copy.
func (s Settings) Clone() Settings {
	c := s
	c.SessionKey = slices.Clone(s.SessionKey)
	c.Auth.AllowedEmails = slices.Clone(s.Auth.AllowedEmails)
	c.Auth.AdminEmails = slices.Clone(s.Auth.AdminEmails)
	c.Auth.GitHubUsers = slices.Clone(s.Auth.GitHubUsers)
	c.Auth.Providers.OIDC.AllowedGroups = slices.Clone(s.Auth.Providers.OIDC.AllowedGroups)
	c.Auth.Providers.Google.AllowedGroups = slices.Clone(s.Auth.Providers.Google.AllowedGroups)
	c.Auth.Providers.GitHub.AllowedGroups = slices.Clone(s.Auth.Providers.GitHub.AllowedGroups)
	c.Auth.Header.Trusted = slices.Clone(s.Auth.Header.Trusted)
	if s.Users != nil {
		c.Users = make([]User, len(s.Users))
		for i, u := range s.Users {
			u.Identities = slices.Clone(u.Identities)
			u.LastLoginAt = cloneTime(u.LastLoginAt)
			u.WebAuthnID = slices.Clone(u.WebAuthnID)
			if u.Passkeys != nil {
				pks := make([]Passkey, len(u.Passkeys))
				for j, p := range u.Passkeys {
					p.CredentialID = slices.Clone(p.CredentialID)
					p.PublicKey = slices.Clone(p.PublicKey)
					p.AAGUID = slices.Clone(p.AAGUID)
					p.Transports = slices.Clone(p.Transports)
					p.LastUsedAt = cloneTime(p.LastUsedAt)
					pks[j] = p
				}
				u.Passkeys = pks
			}
			c.Users[i] = u
		}
	}
	if s.Tokens != nil {
		c.Tokens = make([]Token, len(s.Tokens))
		for i, t := range s.Tokens {
			t.LastUsedAt = cloneTime(t.LastUsedAt)
			t.ExpiresAt = cloneTime(t.ExpiresAt)
			c.Tokens[i] = t
		}
	}
	c.Invites = slices.Clone(s.Invites)
	return c
}

// User returns a pointer to the user with id, nil if none.
func (s *Settings) User(id string) *User {
	for i := range s.Users {
		if s.Users[i].ID == id {
			return &s.Users[i]
		}
	}
	return nil
}

// Defaults returns the settings of a fresh installation (without a session key).
func Defaults() Settings {
	return Settings{
		Version: CurrentVersion,
		Auth: Auth{
			Methods:       Methods{Password: true, Passkey: true},
			AutoProvision: AutoProvision{Enabled: true, Role: RoleViewer},
		},
	}
}

// Store is the settings file plus its in-memory copy.
type Store struct {
	path string
	mu   sync.RWMutex
	cur  Settings
	// wmu serialises Update calls (fn + write) without blocking readers.
	wmu sync.Mutex
	// Migrated is the version the file was migrated from on Open (0 = none).
	Migrated int
	// modTime/size: the file as this process last wrote or read it;
	// checked: when Get last looked (all guarded by mu).
	modTime time.Time
	size    int64
	checked time.Time
}

// Open loads DATA_DIR/jackett-ui.json, creating it (and a session key) when
// missing and migrating an older format. A file with broader permissions
// than 0600 is tightened.
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("store: empty data dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: create data dir: %w", err)
	}
	st := &Store{path: filepath.Join(dir, FileName)}

	data, err := os.ReadFile(st.path)
	changed := false
	switch {
	case errors.Is(err, fs.ErrNotExist):
		st.cur = Defaults()
		changed = true
	case err != nil:
		return nil, fmt.Errorf("store: read %s: %w", st.path, err)
	default:
		var head struct {
			Version int `json:"version"`
		}
		if err := json.Unmarshal(data, &head); err != nil {
			return nil, fmt.Errorf("store: parse %s: %w", st.path, err)
		}
		switch {
		case head.Version > CurrentVersion:
			return nil, fmt.Errorf("store: %s has version %d, this build supports %d", st.path, head.Version, CurrentVersion)
		case head.Version < 2:
			cur, err := migrateV1(data, time.Now())
			if err != nil {
				return nil, fmt.Errorf("store: migrate %s: %w", st.path, err)
			}
			// Keep the original first: if the rewrite fails, the v1 file is
			// still in place and the next start migrates again.
			if err := WriteFileAtomic(filepath.Join(dir, BackupV1Name), data); err != nil {
				return nil, err
			}
			migrateV2(&cur)
			st.cur = cur
			st.Migrated = max(head.Version, 1)
			changed = true
		case head.Version == 2:
			if err := json.Unmarshal(data, &st.cur); err != nil {
				return nil, fmt.Errorf("store: parse %s: %w", st.path, err)
			}
			if err := WriteFileAtomic(filepath.Join(dir, BackupV2Name), data); err != nil {
				return nil, err
			}
			migrateV2(&st.cur)
			st.Migrated = 2
			changed = true
		default:
			if err := json.Unmarshal(data, &st.cur); err != nil {
				return nil, fmt.Errorf("store: parse %s: %w", st.path, err)
			}
		}
		if fi, err := os.Stat(st.path); err == nil && fi.Mode().Perm()&0o077 != 0 {
			_ = os.Chmod(st.path, 0o600)
		}
	}

	if st.cur.Auth.AutoProvision.Role == "" {
		st.cur.Auth.AutoProvision.Role = RoleViewer
	}
	if len(st.cur.SessionKey) != SessionKeySize {
		st.cur.SessionKey = NewSessionKey()
		changed = true
	}
	if changed {
		st.cur.Version = CurrentVersion
		if err := st.write(st.cur); err != nil {
			return nil, err
		}
	} else {
		st.remember()
	}
	return st, nil
}

// migrateV2 converts version 2 settings to version 3: passkeys are a new
// login method, on by default.
func migrateV2(s *Settings) {
	s.Auth.Methods.Passkey = true
}

// Path returns the settings file path.
func (s *Store) Path() string { return s.path }

// externalCheckEvery limits how often Get looks for outside changes.
const externalCheckEvery = time.Second

// Get returns a deep copy of the current settings. If another process (the
// reset-password command) rewrote the file, it is re-read first.
func (s *Store) Get() Settings {
	s.reloadIfChanged(false)
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur.Clone()
}

// remember records the file's mtime and size as "ours". Callers hold s.mu
// for writing, or are the only user of s (Open).
func (s *Store) remember() {
	if fi, err := os.Stat(s.path); err == nil {
		s.modTime, s.size = fi.ModTime(), fi.Size()
	}
	s.checked = time.Now()
}

// reloadIfChanged re-reads the file when its mtime or size differ from what
// this process wrote last. A file that can't be parsed is ignored (the
// in-memory copy stays).
func (s *Store) reloadIfChanged(force bool) {
	s.mu.RLock()
	due := force || time.Since(s.checked) >= externalCheckEvery
	s.mu.RUnlock()
	if !due {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !force && time.Since(s.checked) < externalCheckEvery {
		return
	}
	s.checked = time.Now()
	fi, err := os.Stat(s.path)
	if err != nil || (fi.ModTime().Equal(s.modTime) && fi.Size() == s.size) {
		return
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var next Settings
	if json.Unmarshal(data, &next) != nil || next.Version != CurrentVersion || len(next.SessionKey) != SessionKeySize {
		return
	}
	s.cur = next
	s.modTime, s.size = fi.ModTime(), fi.Size()
}

// Update applies fn to a copy of the settings and writes the result. If fn
// returns an error nothing is written and the error is returned unchanged.
func (s *Store) Update(fn func(*Settings) error) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	// Never overwrite a change another process just made.
	s.reloadIfChanged(true)
	next := s.Get()
	if err := fn(&next); err != nil {
		return err
	}
	next.Version = CurrentVersion
	if err := s.write(next); err != nil {
		return err
	}
	s.mu.Lock()
	s.cur = next
	s.remember()
	s.mu.Unlock()
	return nil
}

func (s *Store) write(v Settings) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("store: encode: %w", err)
	}
	data = append(data, '\n')
	return WriteFileAtomic(s.path, data)
}

// WriteFileAtomic writes data to path via a 0600 temp file in the same
// directory and a rename, so readers never see a partial file.
func WriteFileAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("store: create temp file: %w", err)
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if err = f.Chmod(0o600); err != nil {
		return fmt.Errorf("store: chmod temp file: %w", err)
	}
	if _, err = f.Write(data); err != nil {
		return fmt.Errorf("store: write temp file: %w", err)
	}
	if err = f.Sync(); err != nil {
		return fmt.Errorf("store: sync temp file: %w", err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("store: close temp file: %w", err)
	}
	if err = os.Rename(tmp, path); err != nil {
		return fmt.Errorf("store: rename: %w", err)
	}
	if d, derr := os.Open(dir); derr == nil {
		_ = d.Sync() // best effort: persist the rename
		_ = d.Close()
	}
	return nil
}

// NewSessionKey returns SessionKeySize random bytes.
func NewSessionKey() []byte {
	k := make([]byte, SessionKeySize)
	if _, err := rand.Read(k); err != nil {
		panic("store: crypto/rand failed: " + err.Error())
	}
	return k
}
