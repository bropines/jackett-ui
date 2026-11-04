package store

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"strings"
	"time"
)

// v1 is the version 1 file format (jackett-ui 0.2), read only by the migration.
type v1 struct {
	Version    int    `json:"version"`
	SessionKey []byte `json:"sessionKey"`
	AuthEpoch  uint64 `json:"authEpoch"`
	Auth       struct {
		Mode             string    `json:"mode"`
		PasswordHash     string    `json:"passwordHash"`
		PasswordFallback *bool     `json:"passwordFallback"`
		AllowedEmails    []string  `json:"allowedEmails"`
		GitHubUsers      []string  `json:"githubUsers"`
		Providers        Providers `json:"providers"`
		Header           Header    `json:"header"`
	} `json:"auth"`
	PublicURL  string `json:"publicUrl"`
	SessionTTL string `json:"sessionTtl"`
}

// AdminUsername is the user that the v1 password (and AUTH_PASSWORD) belongs to.
const AdminUsername = "admin"

// migrateV1 converts a version 1 (or 0) file to version 2:
//   - the stored password hash becomes the user "admin" (role admin);
//   - mode → methods: password → {password}; sso → {password: passwordFallback,
//     every provider with a client id}; header → {header}; none → disabled;
//   - allow-lists and providers are kept (they gate auto-provisioning now).
//
// In v1 everybody who got in had full control. To keep that, sso and header
// installations get auto-provisioning with role admin (an admin can lower it).
// The auth epoch is bumped: v1 session cookies don't name a user.
func migrateV1(data []byte, now time.Time) (Settings, error) {
	var o v1
	if err := json.Unmarshal(data, &o); err != nil {
		return Settings{}, err
	}
	n := Defaults()
	n.SessionKey = o.SessionKey
	n.AuthEpoch = o.AuthEpoch + 1
	n.PublicURL = o.PublicURL
	n.SessionTTL = o.SessionTTL
	a := &n.Auth
	a.AllowedEmails = o.Auth.AllowedEmails
	a.GitHubUsers = o.Auth.GitHubUsers
	a.Providers = o.Auth.Providers
	a.Header = o.Auth.Header

	mode := strings.ToLower(strings.TrimSpace(o.Auth.Mode))
	switch mode {
	case "", "password":
		a.Methods = Methods{Password: true}
	case "sso", "oidc":
		fallback := o.Auth.PasswordFallback == nil || *o.Auth.PasswordFallback
		a.Methods = Methods{
			// Without a stored password the fallback was never usable; keeping it on
			// would only re-open the setup wizard.
			Password: fallback && o.Auth.PasswordHash != "",
			OIDC:     a.Providers.OIDC.ClientID != "",
			Google:   a.Providers.Google.ClientID != "",
			GitHub:   a.Providers.GitHub.ClientID != "",
		}
		a.AutoProvision = AutoProvision{Enabled: true, Role: RoleAdmin}
	case "header":
		a.Methods = Methods{Header: true}
		a.AutoProvision = AutoProvision{Enabled: true, Role: RoleAdmin}
	case "none":
		a.Methods = Methods{Password: true}
		a.Disabled = true
	default:
		// Unknown mode: the safe choice is password login.
		a.Methods = Methods{Password: true}
	}

	if o.Auth.PasswordHash != "" {
		n.Users = append(n.Users, User{
			ID:           NewID("u_"),
			Username:     AdminUsername,
			Name:         "Администратор",
			Role:         RoleAdmin,
			PasswordHash: o.Auth.PasswordHash,
			Identities:   []Identity{},
			Epoch:        1,
			CreatedAt:    now.UTC(),
		})
	}
	return n, nil
}

var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// NewID returns prefix + 16 random base32 characters (80 bits).
func NewID(prefix string) string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic("store: crypto/rand failed: " + err.Error())
	}
	return prefix + idEncoding.EncodeToString(b)
}
