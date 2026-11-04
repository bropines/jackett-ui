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
	AllowUnverifiedEmail                                      *bool
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
	// AllowUnverifiedEmail: oidc only; accept email_verified=false for the e-mail allow-list.
	AllowUnverifiedEmail Field[bool]
	VerifiedHash         string
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

// MethodIDs are the login methods in display order.
var MethodIDs = []string{"password", ProviderOIDC, ProviderGoogle, ProviderGitHub, "header"}

// ValidRole reports whether r is viewer, editor or admin.
func ValidRole(r string) bool {
	return r == store.RoleViewer || r == store.RoleEditor || r == store.RoleAdmin
}

// RoleRank orders roles: viewer 1, editor 2, admin 3, unknown 0.
func RoleRank(r string) int {
	switch r {
	case store.RoleViewer:
		return 1
	case store.RoleEditor:
		return 2
	case store.RoleAdmin:
		return 3
	}
	return 0
}

// Effective is the merged configuration.
type Effective struct {
	// Methods are the login method switches (AUTH_METHODS, or the
	// deprecated AUTH_MODE, locks all of them).
	Methods  Field[store.Methods]
	Disabled Field[bool]
	// AdminPassword is the env password hash (AUTH_PASSWORD[_HASH]) of the
	// user "admin"; Value "" = none (the stored hash applies).
	AdminPassword Field[string]

	AutoProvision Field[bool]
	DefaultRole   Field[string]

	AllowedEmails Field[[]string]
	AdminEmails   Field[[]string]
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
	// UserCount is the number of stored users (0 = setup / bootstrap).
	UserCount int
}

// Resolve merges env over the stored settings.
func Resolve(env *Env, s store.Settings) (Effective, error) {
	a := s.Auth
	var e Effective
	e.Epoch = s.AuthEpoch
	e.UserCount = len(s.Users)

	if env.PasswordHash != "" {
		e.AdminPassword = Field[string]{Value: env.PasswordHash, Locked: true, Env: env.PasswordVar}
	}

	e.AllowedEmails = pick(env.AllowedEmails, "AUTH_ALLOWED_EMAILS", nonNil(a.AllowedEmails), true, []string{})
	e.AdminEmails = pick(env.AdminEmails, "AUTH_ADMIN_EMAILS", nonNil(a.AdminEmails), true, []string{})
	e.GitHubUsers = pick(env.GitHubUsers, "GITHUB_USERS", nonNil(a.GitHubUsers), true, []string{})
	e.AutoProvision = pick(env.AutoProvision, "AUTH_AUTO_PROVISION", a.AutoProvision.Enabled, true, false)
	storedRole := strings.ToLower(a.AutoProvision.Role)
	e.DefaultRole = pick(env.DefaultRole, "AUTH_DEFAULT_ROLE", storedRole, storedRole != "", store.RoleViewer)
	if !ValidRole(e.DefaultRole.Value) {
		return e, fmt.Errorf("settings: unknown auto-provision role %q", e.DefaultRole.Value)
	}

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
			p.AllowUnverifiedEmail = pick(ev.AllowUnverifiedEmail, "OIDC_ALLOW_UNVERIFIED_EMAIL", sp.AllowUnverifiedEmail, true, false)
		case ProviderGoogle:
			p.Issuer = fixed(GoogleIssuer)
			p.Name = fixed("Google")
			p.Scopes = fixed(DefaultScopes)
			p.Groups = fixed([]string{})
			p.AllowUnverifiedEmail = fixed(false)
		case ProviderGitHub:
			p.Name = fixed("GitHub")
			p.Scopes = fixed("read:user user:email")
			p.Groups = fixed([]string{})
			p.AllowUnverifiedEmail = fixed(false)
		}
		e.Providers[id] = p
	}

	// Methods: AUTH_METHODS, else the deprecated AUTH_MODE, else stored.
	switch {
	case env.Methods != nil:
		e.Methods = Field[store.Methods]{Value: *env.Methods, Locked: true, Env: "AUTH_METHODS"}
	case env.AuthMode != "":
		var m store.Methods
		switch env.AuthMode {
		case auth.ModePassword, auth.ModeNone:
			m.Password = true
		case auth.ModeHeader:
			m.Header = true
		case auth.ModeSSO:
			m.Password = env.PasswordFallback == nil || *env.PasswordFallback
			m.OIDC = e.Providers[ProviderOIDC].Enabled()
			m.Google = e.Providers[ProviderGoogle].Enabled()
			m.GitHub = e.Providers[ProviderGitHub].Enabled()
		}
		e.Methods = Field[store.Methods]{Value: m, Locked: true, Env: "AUTH_MODE"}
	default:
		e.Methods = Field[store.Methods]{Value: a.Methods}
	}
	switch {
	case env.Disabled != nil:
		e.Disabled = Field[bool]{Value: *env.Disabled, Locked: true, Env: "AUTH_DISABLED"}
	case env.AuthMode != "":
		e.Disabled = Field[bool]{Value: env.AuthMode == auth.ModeNone, Locked: true, Env: "AUTH_MODE"}
	default:
		e.Disabled = Field[bool]{Value: a.Disabled}
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
	if e.Disabled.Value {
		return nil
	}
	m := e.Methods.Value
	if m.Header && len(e.HeaderPrefixes) == 0 {
		return errors.New("the header login method requires trusted proxy CIDRs (AUTH_HEADER_TRUSTED)")
	}
	if e.Methods.Locked {
		for _, id := range ProviderIDs {
			if m.Get(id) && !e.Providers[id].Enabled() {
				return fmt.Errorf("%s turns on the %s login, but the provider is not configured (%s)", e.Methods.Env, id, providerVars(id))
			}
		}
	}
	return nil
}

func providerVars(id string) string {
	switch id {
	case ProviderOIDC:
		return "OIDC_ISSUER + OIDC_CLIENT_ID"
	case ProviderGoogle:
		return "GOOGLE_CLIENT_ID"
	}
	return "GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET"
}

// SetupRequired: login is on and there are no users yet. The setup wizard
// (or the first allowed external / header login) creates the first admin.
// SetupRequired: the password setup wizard is open. Only while there are no
// users AND password is the only login method: with SSO or header login on,
// the first allowed external login becomes the admin instead, so an
// SSO-configured instance never offers "create the admin" to anonymous
// visitors (that would hand the first visitor the panel).
func (e Effective) SetupRequired() bool {
	if e.Disabled.Value || e.UserCount != 0 {
		return false
	}
	m := e.Methods.Value
	return m.Password && !m.OIDC && !m.Google && !m.GitHub && !m.Header
}

// MethodOn reports whether login method id is switched on (and login is
// not disabled).
func (e Effective) MethodOn(id string) bool {
	return !e.Disabled.Value && e.Methods.Value.Get(id)
}

// PasswordLogin reports whether the password form is offered.
func (e Effective) PasswordLogin() bool { return e.MethodOn("password") }

// HeaderLogin reports whether trusted-header login is active.
func (e Effective) HeaderLogin() bool {
	return e.MethodOn("header") && len(e.HeaderPrefixes) > 0
}

// EnabledProviders returns the configured providers in display order.
func (e Effective) EnabledProviders() []Provider {
	var out []Provider
	for _, id := range ProviderIDs {
		if p := e.Providers[id]; p.Enabled() {
			out = append(out, p)
		}
	}
	return out
}

// ProviderReady: configured and verified (usable for linking even while
// its login method is off).
func (e Effective) ProviderReady(id string) bool {
	p, ok := e.Providers[id]
	return ok && p.Enabled() && p.Verified()
}

// LoginProviders are the providers offered on the login page: method on,
// configured and verified.
func (e Effective) LoginProviders() []Provider {
	var out []Provider
	for _, p := range e.EnabledProviders() {
		if e.MethodOn(p.ID) && p.Verified() {
			out = append(out, p)
		}
	}
	return out
}

// AllowListSet reports whether any allow-list is configured. Without one,
// external logins can't auto-provision accounts.
func (e Effective) AllowListSet() bool {
	return len(e.AllowedEmails.Value) > 0 || len(e.AdminEmails.Value) > 0 || len(e.GitHubUsers.Value) > 0 ||
		len(e.Providers[ProviderOIDC].Groups.Value) > 0
}

// ProviderCanAllow reports whether some allow-list could admit a user of
// provider id: e-mails (allowed or admin) for all; GitHub users for github;
// groups for oidc.
func (e Effective) ProviderCanAllow(id string) bool {
	if len(e.AllowedEmails.Value) > 0 || len(e.AdminEmails.Value) > 0 {
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
