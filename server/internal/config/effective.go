package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/netutil"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// External login provider ids.
const (
	ProviderOIDC   = "oidc"
	ProviderGoogle = "google"
	ProviderGitHub = "github"
)

// ProviderIDs in display order.
var ProviderIDs = []string{ProviderOIDC, ProviderGoogle, ProviderGitHub}

// GoogleIssuer is the fixed issuer of the google provider.
const GoogleIssuer = "https://accounts.google.com"

// ValidProvider reports whether id is a known provider.
func ValidProvider(id string) bool {
	return id == ProviderOIDC || id == ProviderGoogle || id == ProviderGitHub
}

// NormalizeMode lower-cases m and maps the legacy "oidc" to "sso".
func NormalizeMode(m string) string {
	m = strings.ToLower(strings.TrimSpace(m))
	if m == "oidc" {
		return auth.ModeSSO
	}
	return m
}

// EnvProvider is one provider's env values (nil = unset).
type EnvProvider struct {
	Issuer, ClientID, ClientSecret, Name, Scopes, GroupsClaim *string
	Groups                                                    *[]string
}

// Field is a value plus where it came from.
type Field[T any] struct {
	Value  T
	Locked bool
	Env    string // variable name when locked
}

func pick[T any](envVal *T, envName string, stored T, useStored bool, def T) Field[T] {
	if envVal != nil {
		return Field[T]{Value: *envVal, Locked: true, Env: envName}
	}
	if useStored {
		return Field[T]{Value: stored}
	}
	return Field[T]{Value: def}
}

func fixed[T any](v T) Field[T] { return Field[T]{Value: v} }

// Provider is one provider's effective configuration.
type Provider struct {
	ID           string
	Issuer       Field[string] // oidc: configurable; google: fixed; github: ""
	ClientID     Field[string]
	ClientSecret Field[string]
	Name         Field[string]
	Scopes       Field[string]
	Groups       Field[[]string] // oidc only
	GroupsClaim  Field[string]   // oidc only
	VerifiedHash string
}

// Enabled: the provider has a client id (and, for oidc, an issuer).
func (p Provider) Enabled() bool {
	if p.ClientID.Value == "" {
		return false
	}
	switch p.ID {
	case ProviderOIDC:
		return p.Issuer.Value != ""
	case ProviderGitHub:
		return p.ClientSecret.Value != ""
	}
	return true
}

// Hash identifies the issuer/client/secret/scopes combination.
func (p Provider) Hash() string {
	return ProviderHash(p.ID, p.Issuer.Value, p.ClientID.Value, p.ClientSecret.Value, p.Scopes.Value)
}

// FromEnv: the identity-relevant settings all come from the environment
// (the operator configured it explicitly; no test login is required).
func (p Provider) FromEnv() bool {
	if !p.ClientID.Locked {
		return false
	}
	if p.ID == ProviderOIDC && !p.Issuer.Locked {
		return false
	}
	return p.ClientSecret.Locked || p.ClientSecret.Value == ""
}

// Verified: the current settings passed a test login, or come from env.
func (p Provider) Verified() bool {
	if p.FromEnv() {
		return true
	}
	return p.VerifiedHash != "" && p.VerifiedHash == p.Hash()
}

// ProviderHash is the "verified" fingerprint.
func ProviderHash(id, issuer, clientID, clientSecret, scopes string) string {
	h := sha256.New()
	for _, s := range []string{id, strings.TrimSpace(issuer), strings.TrimSpace(clientID), clientSecret, strings.Join(strings.Fields(scopes), " ")} {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Effective is the merged configuration.
type Effective struct {
	Mode             Field[string]
	PasswordHash     Field[string] // Value: effective hash ("" = none)
	PasswordFallback Field[bool]

	AllowedEmails Field[[]string]
	GitHubUsers   Field[[]string]
	Providers     map[string]Provider

	HeaderName    Field[string]
	HeaderTrusted Field[[]string]
	// HeaderPrefixes is HeaderTrusted parsed.
	HeaderPrefixes []netip.Prefix

	PublicURL  Field[string]
	PublicURLp *url.URL
	SessionTTL Field[time.Duration]

	Epoch uint64
}

// Resolve merges env over the stored settings.
func Resolve(env *Env, s store.Settings) (Effective, error) {
	a := s.Auth
	var e Effective
	e.Epoch = s.AuthEpoch

	var envMode *string
	if env.AuthMode != "" {
		envMode = &env.AuthMode
	}
	e.Mode = pick(envMode, "AUTH_MODE", NormalizeMode(a.Mode), a.Mode != "", auth.ModePassword)
	if !auth.ValidMode(e.Mode.Value) {
		return e, fmt.Errorf("settings: unknown auth mode %q", e.Mode.Value)
	}

	if env.PasswordHash != "" {
		e.PasswordHash = Field[string]{Value: env.PasswordHash, Locked: true, Env: env.PasswordVar}
	} else {
		e.PasswordHash = Field[string]{Value: a.PasswordHash}
	}

	var storedFB bool
	if a.PasswordFallback != nil {
		storedFB = *a.PasswordFallback
	}
	e.PasswordFallback = pick(env.PasswordFallback, "AUTH_PASSWORD_FALLBACK", storedFB, a.PasswordFallback != nil, true)

	e.AllowedEmails = pick(env.AllowedEmails, "AUTH_ALLOWED_EMAILS", nonNil(a.AllowedEmails), true, []string{})
	e.GitHubUsers = pick(env.GitHubUsers, "GITHUB_USERS", nonNil(a.GitHubUsers), true, []string{})

	e.Providers = map[string]Provider{}
	for _, id := range ProviderIDs {
		ev := env.Providers[id]
		if ev == nil {
			ev = &EnvProvider{}
		}
		sp := *a.Providers.Get(id)
		up := strings.ToUpper(id)
		p := Provider{ID: id, VerifiedHash: sp.VerifiedHash}
		p.ClientID = pick(ev.ClientID, up+"_CLIENT_ID", sp.ClientID, true, "")
		p.ClientSecret = pick(ev.ClientSecret, up+"_CLIENT_SECRET", sp.ClientSecret, true, "")
		switch id {
		case ProviderOIDC:
			p.Issuer = pick(ev.Issuer, "OIDC_ISSUER", sp.Issuer, true, "")
			p.Name = pick(ev.Name, "OIDC_PROVIDER_NAME", sp.ProviderName, sp.ProviderName != "", DefaultProviderName)
			p.Scopes = pick(ev.Scopes, "OIDC_SCOPES", sp.Scopes, sp.Scopes != "", DefaultScopes)
			p.Groups = pick(ev.Groups, "OIDC_ALLOWED_GROUPS", nonNil(sp.AllowedGroups), true, []string{})
			p.GroupsClaim = pick(ev.GroupsClaim, "OIDC_GROUPS_CLAIM", sp.GroupsClaim, sp.GroupsClaim != "", DefaultGroupsClaim)
		case ProviderGoogle:
			p.Issuer = fixed(GoogleIssuer)
			p.Name = fixed("Google")
			p.Scopes = fixed(DefaultScopes)
			p.Groups = fixed([]string{})
		case ProviderGitHub:
			p.Name = fixed("GitHub")
			p.Scopes = fixed("read:user user:email")
			p.Groups = fixed([]string{})
		}
		e.Providers[id] = p
	}

	h := a.Header
	e.HeaderName = pick(env.HeaderName, "AUTH_HEADER_NAME", h.Name, h.Name != "", DefaultHeaderName)
	e.HeaderTrusted = pick(env.HeaderTrusted, "AUTH_HEADER_TRUSTED", nonNil(h.Trusted), true, []string{})
	p, err := netutil.ParsePrefixList(e.HeaderTrusted.Value)
	if err != nil {
		return e, fmt.Errorf("settings: header trusted: %w", err)
	}
	e.HeaderPrefixes = p

	if env.PublicURL != nil {
		e.PublicURL = Field[string]{Value: env.PublicURLRaw, Locked: true, Env: "PUBLIC_URL"}
		e.PublicURLp = env.PublicURL
	} else if s.PublicURL != "" {
		u, err := ParsePublicURL(s.PublicURL)
		if err != nil {
			return e, fmt.Errorf("settings: publicUrl: %w", err)
		}
		e.PublicURL = Field[string]{Value: u.String()}
		e.PublicURLp = u
	}

	switch {
	case env.SessionTTL > 0:
		e.SessionTTL = Field[time.Duration]{Value: env.SessionTTL, Locked: true, Env: "SESSION_TTL"}
	case s.SessionTTL != "":
		d, err := ParseSessionTTL(s.SessionTTL)
		if err != nil {
			return e, fmt.Errorf("settings: sessionTtl: %w", err)
		}
		e.SessionTTL = Field[time.Duration]{Value: d}
	default:
		e.SessionTTL = Field[time.Duration]{Value: DefaultSessionTTL}
	}
	return e, nil
}

func nonNil(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

// Validate checks rules that need the merged view (used at start-up).
func (e Effective) Validate() error {
	switch e.Mode.Value {
	case auth.ModeHeader:
		if len(e.HeaderPrefixes) == 0 {
			return errors.New("auth mode header requires trusted proxy CIDRs (AUTH_HEADER_TRUSTED)")
		}
	case auth.ModeSSO:
		if len(e.EnabledProviders()) == 0 {
			return errors.New("auth mode sso requires at least one login provider (OIDC_ISSUER + OIDC_CLIENT_ID, GOOGLE_CLIENT_ID, or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET)")
		}
	}
	return nil
}

// SetupRequired is true in password mode without any password.
func (e Effective) SetupRequired() bool {
	return e.Mode.Value == auth.ModePassword && e.PasswordHash.Value == ""
}

// PasswordLogin reports whether the password form is offered.
func (e Effective) PasswordLogin() bool {
	switch e.Mode.Value {
	case auth.ModePassword:
		return e.PasswordHash.Value != ""
	case auth.ModeSSO:
		return e.PasswordFallback.Value && e.PasswordHash.Value != ""
	}
	return false
}

// EnabledProviders returns the enabled providers in display order.
func (e Effective) EnabledProviders() []Provider {
	var out []Provider
	for _, id := range ProviderIDs {
		if p := e.Providers[id]; p.Enabled() {
			out = append(out, p)
		}
	}
	return out
}

// AllowListSet reports whether any allow-list is configured. Without one,
// external logins are refused.
func (e Effective) AllowListSet() bool {
	return len(e.AllowedEmails.Value) > 0 || len(e.GitHubUsers.Value) > 0 || len(e.Providers[ProviderOIDC].Groups.Value) > 0
}

// ProviderCanAllow reports whether some allow-list could admit a user of
// provider id: emails for all; GitHub users for github; groups for oidc.
func (e Effective) ProviderCanAllow(id string) bool {
	if len(e.AllowedEmails.Value) > 0 {
		return true
	}
	switch id {
	case ProviderGitHub:
		return len(e.GitHubUsers.Value) > 0
	case ProviderOIDC:
		return len(e.Providers[ProviderOIDC].Groups.Value) > 0
	}
	return false
}

// LoginProviders are the providers offered on the login page: mode sso,
// enabled, verified, and an allow-list that can admit its users.
func (e Effective) LoginProviders() []Provider {
	if e.Mode.Value != auth.ModeSSO {
		return nil
	}
	var out []Provider
	for _, p := range e.EnabledProviders() {
		if p.Verified() && e.ProviderCanAllow(p.ID) {
			out = append(out, p)
		}
	}
	return out
}

// SessionTTLString formats the TTL compactly ("168h", "30m", "1h30m").
func SessionTTLString(d time.Duration) string {
	s := d.String()
	s = strings.TrimSuffix(s, "0s")
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	if s == "" {
		return "0s"
	}
	return s
}
