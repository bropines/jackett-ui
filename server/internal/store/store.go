// Package store keeps the jackett-ui settings file (DATA_DIR/jackett-ui.json).
//
// The file is created with mode 0600 and always written atomically (temp file
// in the same directory, fsync, rename). Readers get deep copies, writers go
// through Update, which serialises changes and only swaps the in-memory copy
// after the file was written successfully.
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
)

// FileName is the settings file name inside DATA_DIR.
const FileName = "jackett-ui.json"

// CurrentVersion is the settings file format version.
const CurrentVersion = 1

// SessionKeySize is the size of the HMAC key for sessions.
const SessionKeySize = 32

// Settings is the content of the settings file.
type Settings struct {
	Version    int    `json:"version"`
	SessionKey []byte `json:"sessionKey"` // base64 in JSON
	AuthEpoch  uint64 `json:"authEpoch"`
	Auth       Auth   `json:"auth"`
	// PublicURL and SessionTTL are optional; env (PUBLIC_URL, SESSION_TTL) wins.
	PublicURL  string `json:"publicUrl,omitempty"`
	SessionTTL string `json:"sessionTtl,omitempty"`
}

// Auth holds the stored authentication settings.
type Auth struct {
	Mode             string `json:"mode,omitempty"`
	PasswordHash     string `json:"passwordHash,omitempty"`
	PasswordFallback *bool  `json:"passwordFallback,omitempty"`
	// AllowedEmails applies to every external provider; GitHubUsers to
	// GitHub logins. Empty everywhere = external logins are refused.
	AllowedEmails []string  `json:"allowedEmails"`
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

// Clone returns a deep copy.
func (s Settings) Clone() Settings {
	c := s
	c.SessionKey = slices.Clone(s.SessionKey)
	if s.Auth.PasswordFallback != nil {
		v := *s.Auth.PasswordFallback
		c.Auth.PasswordFallback = &v
	}
	c.Auth.AllowedEmails = slices.Clone(s.Auth.AllowedEmails)
	c.Auth.GitHubUsers = slices.Clone(s.Auth.GitHubUsers)
	c.Auth.Providers.OIDC.AllowedGroups = slices.Clone(s.Auth.Providers.OIDC.AllowedGroups)
	c.Auth.Providers.Google.AllowedGroups = slices.Clone(s.Auth.Providers.Google.AllowedGroups)
	c.Auth.Providers.GitHub.AllowedGroups = slices.Clone(s.Auth.Providers.GitHub.AllowedGroups)
	c.Auth.Header.Trusted = slices.Clone(s.Auth.Header.Trusted)
	return c
}

// Store is the settings file plus its in-memory copy.
type Store struct {
	path string
	mu   sync.RWMutex
	cur  Settings
	// wmu serialises Update calls (fn + write) without blocking readers.
	wmu sync.Mutex
}

// Open loads DATA_DIR/jackett-ui.json, creating it (and a session key) when
// missing. A file with broader permissions than 0600 is tightened.
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("store: empty data dir")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: create data dir: %w", err)
	}
	st := &Store{path: filepath.Join(dir, FileName)}

	data, err := os.ReadFile(st.path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		st.cur = Settings{Version: CurrentVersion}
	case err != nil:
		return nil, fmt.Errorf("store: read %s: %w", st.path, err)
	default:
		if err := json.Unmarshal(data, &st.cur); err != nil {
			return nil, fmt.Errorf("store: parse %s: %w", st.path, err)
		}
		if st.cur.Version > CurrentVersion {
			return nil, fmt.Errorf("store: %s has version %d, this build supports %d", st.path, st.cur.Version, CurrentVersion)
		}
		if fi, err := os.Stat(st.path); err == nil && fi.Mode().Perm()&0o077 != 0 {
			_ = os.Chmod(st.path, 0o600)
		}
	}

	changed := errors.Is(err, fs.ErrNotExist)
	if st.cur.Version == 0 {
		st.cur.Version = CurrentVersion
		changed = true
	}
	if len(st.cur.SessionKey) != SessionKeySize {
		st.cur.SessionKey = NewSessionKey()
		changed = true
	}
	if changed {
		if err := st.write(st.cur); err != nil {
			return nil, err
		}
	}
	return st, nil
}

// Path returns the settings file path.
func (s *Store) Path() string { return s.path }

// Get returns a deep copy of the current settings.
func (s *Store) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cur.Clone()
}

// Update applies fn to a copy of the settings and writes the result. If fn
// returns an error nothing is written and the error is returned unchanged.
func (s *Store) Update(fn func(*Settings) error) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
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
