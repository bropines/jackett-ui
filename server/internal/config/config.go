// Package config parses the environment (Env) and merges it with the stored
// settings (Effective). Environment variables always win; a value that comes
// from the environment is "locked" and cannot be changed through the API.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/netutil"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// Defaults.
const (
	DefaultListen         = ":8080"
	DefaultJackettURL     = "http://127.0.0.1:9117"
	DefaultDataDir        = "/config"
	DefaultTrustedProxies = "127.0.0.1/32,::1/128"
	DefaultProviderName   = "SSO"
	DefaultScopes         = "openid email profile"
	DefaultGroupsClaim    = "groups"
	DefaultHeaderName     = "Remote-User"
	DefaultSessionTTL     = 168 * time.Hour
	MinSessionTTL         = 5 * time.Minute
	MaxSessionTTL         = 366 * 24 * time.Hour
)

// Env is the parsed environment. A field's env var counts as set when it is
// present and non-empty (compose files often pass FOO= for "unset").
type Env struct {
	Listen          string
	JackettURL      *url.URL
	JackettPassword string
	DataDir         string
	TrustedProxies  []netip.Prefix
	StaticDir       string
	LogLevel        slog.Level
	AuthReset       bool

	PublicURL    *url.URL // nil = unset
	PublicURLRaw string

	// AuthMode is the deprecated AUTH_MODE ("" = unset), mapped to methods
	// in Resolve.
	AuthMode string

	// Methods from AUTH_METHODS (nil = unset).
	Methods *store.Methods
	// Disabled from AUTH_DISABLED (nil = unset).
	Disabled *bool
	// AutoProvision (AUTH_AUTO_PROVISION), DefaultRole (AUTH_DEFAULT_ROLE),
	// AdminEmails (AUTH_ADMIN_EMAILS); nil = unset.
	AutoProvision *bool
	DefaultRole   *string
	AdminEmails   *[]string

	// PasswordHash is the bcrypt hash from AUTH_PASSWORD (hashed at parse
	// time, the plain password is not kept) or AUTH_PASSWORD_HASH. It is the
	// password of the user "admin".
	PasswordHash string
	// PasswordVar is the variable that set it ("" = unset).
	PasswordVar string

	// PasswordFallback (AUTH_PASSWORD_FALLBACK): only with AUTH_MODE=sso.
	PasswordFallback *bool

	// Providers holds the env values of the external login providers, keyed
	// by provider id (always has all three keys).
	Providers     map[string]*EnvProvider
	AllowedEmails *[]string // AUTH_ALLOWED_EMAILS
	GitHubUsers   *[]string // GITHUB_USERS

	HeaderName    *string
	HeaderTrusted *[]string

	SessionTTL    time.Duration // 0 = unset
	SessionTTLRaw string

	// Set lists the variables that were set (for the start-up log; values
	// are never logged).
	Set []string
}

// Lookup is os.LookupEnv-like.
type Lookup func(string) (string, bool)

// ParseEnv reads and validates the environment.
func ParseEnv(lookup Lookup) (*Env, error) {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	e := &Env{}
	var errs []error
	get := func(name string) (string, bool) {
		v, ok := lookup(name)
		v = strings.TrimSpace(v)
		if !ok || v == "" {
			return "", false
		}
		e.Set = append(e.Set, name)
		return v, true
	}
	str := func(name string) *string {
		if v, ok := get(name); ok {
			return &v
		}
		return nil
	}
	list := func(name string) *[]string {
		if v, ok := get(name); ok {
			l := SplitList(v)
			return &l
		}
		return nil
	}
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }

	e.Listen = DefaultListen
	if v, ok := get("LISTEN"); ok {
		e.Listen = v
	}

	ju := DefaultJackettURL
	if v, ok := get("JACKETT_URL"); ok {
		ju = v
	}
	if u, err := parseBaseURL(ju, true); err != nil {
		fail("JACKETT_URL: %v", err)
	} else {
		e.JackettURL = u
	}
	if v, ok := lookup("JACKETT_PASSWORD"); ok && v != "" {
		e.JackettPassword = v // not trimmed: passwords may contain spaces
		e.Set = append(e.Set, "JACKETT_PASSWORD")
	}

	e.DataDir = DefaultDataDir
	if v, ok := get("DATA_DIR"); ok {
		e.DataDir = v
	}

	tp := DefaultTrustedProxies
	if v, ok := get("TRUSTED_PROXIES"); ok {
		tp = v
	}
	if p, err := netutil.ParsePrefixes(tp); err != nil {
		fail("TRUSTED_PROXIES: %v", err)
	} else {
		e.TrustedProxies = p
	}

	if v, ok := get("PUBLIC_URL"); ok {
		u, err := ParsePublicURL(v)
		if err != nil {
			fail("PUBLIC_URL: %v", err)
		} else {
			e.PublicURL = u
			e.PublicURLRaw = u.String()
		}
	}

	if v, ok := get("AUTH_MODE"); ok {
		v = NormalizeMode(v)
		if !auth.ValidMode(v) {
			fail("AUTH_MODE: %q is not one of password, sso, header, none", v)
		}
		e.AuthMode = v
	}
	if v, ok := get("AUTH_METHODS"); ok {
		var m store.Methods
		for _, id := range SplitList(strings.ToLower(v)) {
			p := m.Ptr(id)
			if p == nil {
				fail("AUTH_METHODS: %q is not one of password, oidc, google, github, header", id)
				continue
			}
			*p = true
		}
		e.Methods = &m
		if e.AuthMode != "" {
			fail("AUTH_MODE (deprecated) and AUTH_METHODS are both set; use AUTH_METHODS")
		}
	}
	boolVar := func(name string) *bool {
		v, ok := get(name)
		if !ok {
			return nil
		}
		b, err := strconv.ParseBool(v)
		if err != nil {
			fail("%s: %q is not a boolean", name, v)
			return nil
		}
		return &b
	}
	e.Disabled = boolVar("AUTH_DISABLED")
	if e.Disabled != nil && e.AuthMode != "" {
		fail("AUTH_MODE (deprecated) and AUTH_DISABLED are both set; use AUTH_DISABLED")
	}
	e.AutoProvision = boolVar("AUTH_AUTO_PROVISION")
	if v, ok := get("AUTH_DEFAULT_ROLE"); ok {
		v = strings.ToLower(v)
		if !ValidRole(v) {
			fail("AUTH_DEFAULT_ROLE: %q is not one of viewer, editor, admin", v)
		}
		e.DefaultRole = &v
	}
	e.AdminEmails = list("AUTH_ADMIN_EMAILS")

	pw, hasPW := lookup("AUTH_PASSWORD")
	hasPW = hasPW && pw != ""
	hash, hasHash := get("AUTH_PASSWORD_HASH")
	switch {
	case hasPW && hasHash:
		fail("AUTH_PASSWORD and AUTH_PASSWORD_HASH are both set; use one")
	case hasPW:
		e.Set = append(e.Set, "AUTH_PASSWORD")
		h, err := auth.HashPassword(pw)
		if err != nil {
			fail("AUTH_PASSWORD: %s", passwordErrText(err))
		} else {
			e.PasswordHash, e.PasswordVar = h, "AUTH_PASSWORD"
		}
	case hasHash:
		if !auth.ValidHash(hash) {
			fail("AUTH_PASSWORD_HASH: not a bcrypt hash")
		} else {
			e.PasswordHash, e.PasswordVar = hash, "AUTH_PASSWORD_HASH"
		}
	}

	if v, ok := get("AUTH_PASSWORD_FALLBACK"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			fail("AUTH_PASSWORD_FALLBACK: %q is not a boolean", v)
		} else {
			e.PasswordFallback = &b
		}
	}

	secret := func(name string) *string {
		if v, ok := lookup(name); ok && v != "" {
			e.Set = append(e.Set, name)
			return &v
		}
		return nil
	}
	e.Providers = map[string]*EnvProvider{}
	po := &EnvProvider{
		Issuer:       str("OIDC_ISSUER"),
		ClientID:     str("OIDC_CLIENT_ID"),
		ClientSecret: secret("OIDC_CLIENT_SECRET"),
		Name:         str("OIDC_PROVIDER_NAME"),
		Scopes:       str("OIDC_SCOPES"),
		Groups:       list("OIDC_ALLOWED_GROUPS"),
		GroupsClaim:  str("OIDC_GROUPS_CLAIM"),
	}
	if v, ok := get("OIDC_ALLOW_UNVERIFIED_EMAIL"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			fail("OIDC_ALLOW_UNVERIFIED_EMAIL: %q is not a boolean", v)
		} else {
			po.AllowUnverifiedEmail = &b
		}
	}
	if po.Issuer != nil {
		if _, err := parseBaseURL(*po.Issuer, false); err != nil {
			fail("OIDC_ISSUER: %v", err)
		}
	}
	e.Providers[ProviderOIDC] = po
	e.Providers[ProviderGoogle] = &EnvProvider{ClientID: str("GOOGLE_CLIENT_ID"), ClientSecret: secret("GOOGLE_CLIENT_SECRET")}
	e.Providers[ProviderGitHub] = &EnvProvider{ClientID: str("GITHUB_CLIENT_ID"), ClientSecret: secret("GITHUB_CLIENT_SECRET")}
	if gh := e.Providers[ProviderGitHub]; gh.ClientID != nil && gh.ClientSecret == nil {
		fail("GITHUB_CLIENT_ID is set but GITHUB_CLIENT_SECRET is not (GitHub requires the secret)")
	}
	e.AllowedEmails = list("AUTH_ALLOWED_EMAILS")
	e.GitHubUsers = list("GITHUB_USERS")
	if _, ok := get("OIDC_ALLOWED_EMAILS"); ok {
		fail("OIDC_ALLOWED_EMAILS was replaced by AUTH_ALLOWED_EMAILS (applies to every login provider)")
	}

	e.HeaderName = str("AUTH_HEADER_NAME")
	if e.HeaderName != nil && !validHeaderName(*e.HeaderName) {
		fail("AUTH_HEADER_NAME: %q is not a valid header name", *e.HeaderName)
	}
	if v, ok := get("AUTH_HEADER_TRUSTED"); ok {
		l := SplitList(v)
		if _, err := netutil.ParsePrefixList(l); err != nil {
			fail("AUTH_HEADER_TRUSTED: %v", err)
		}
		e.HeaderTrusted = &l
	}
	if (e.AuthMode == auth.ModeHeader || (e.Methods != nil && e.Methods.Header)) && e.HeaderTrusted == nil {
		fail("the header login method requires AUTH_HEADER_TRUSTED (the CIDRs of the reverse proxy that sets %s)", deref(e.HeaderName, DefaultHeaderName))
	}

	if v, ok := get("SESSION_TTL"); ok {
		d, err := ParseSessionTTL(v)
		if err != nil {
			fail("SESSION_TTL: %v", err)
		} else {
			e.SessionTTL, e.SessionTTLRaw = d, v
		}
	}

	if v, ok := get("AUTH_RESET"); ok {
		b, err := strconv.ParseBool(v)
		if err != nil {
			fail("AUTH_RESET: %q is not a boolean (use 1)", v)
		}
		e.AuthReset = b
	}

	e.StaticDir, _ = get("STATIC_DIR")

	e.LogLevel = slog.LevelInfo
	if v, ok := get("LOG_LEVEL"); ok {
		if err := e.LogLevel.UnmarshalText([]byte(v)); err != nil {
			fail("LOG_LEVEL: %q is not one of debug, info, warn, error", v)
		}
	}

	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return e, nil
}

func passwordErrText(err error) string {
	switch {
	case errors.Is(err, auth.ErrPasswordTooShort):
		return fmt.Sprintf("must be at least %d characters", auth.MinPasswordLen)
	case errors.Is(err, auth.ErrPasswordTooLong):
		return "must be at most 72 bytes"
	}
	return err.Error()
}

func deref(p *string, def string) string {
	if p != nil {
		return *p
	}
	return def
}

// SplitList splits a comma separated list, dropping empty items.
func SplitList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseBaseURL(s string, allowPath bool) (*url.URL, error) {
	u, err := url.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("invalid URL %q", s)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("%q must start with http:// or https://", s)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("%q has no host", s)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("%q must not contain credentials, query or fragment", s)
	}
	if allowPath {
		u.Path = strings.TrimRight(u.Path, "/")
		u.RawPath = ""
	}
	return u, nil
}

// ParsePublicURL validates PUBLIC_URL: absolute http(s) URL without path
// (the UI is served at the root).
func ParsePublicURL(s string) (*url.URL, error) {
	u, err := parseBaseURL(strings.TrimRight(s, "/"), false)
	if err != nil {
		return nil, err
	}
	if u.Path != "" {
		return nil, fmt.Errorf("%q must not have a path (the UI is served at /)", s)
	}
	u.Host = strings.ToLower(u.Host)
	return u, nil
}

// ParseSessionTTL parses and bounds a session lifetime.
func ParseSessionTTL(s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%q is not a duration (e.g. 168h)", s)
	}
	if d < MinSessionTTL || d > MaxSessionTTL {
		return 0, fmt.Errorf("%q must be between %s and %s", s, MinSessionTTL, MaxSessionTTL)
	}
	return d, nil
}

func validHeaderName(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// ValidHeaderName is exported for the settings API.
func ValidHeaderName(s string) bool { return validHeaderName(s) }
