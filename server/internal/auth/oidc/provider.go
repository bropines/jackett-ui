package oidc

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// flowCookiePath scopes the flow cookie to the login routes (/_ui/auth/{provider}/...).
const flowCookiePath = "/_ui/auth/" // shared by all providers; the cookie is bound to one issuer+client

// defaultHTTPTimeout is used when New gets a nil client.
const defaultHTTPTimeout = 10 * time.Second

// randomBytes is the entropy of state, nonce and PKCE verifier.
const randomBytes = 32

// now is replaceable in tests.
var now = time.Now

// flowState is the signed payload of the flow cookie.
type flowState struct {
	State     string `json:"s"`
	Nonce     string `json:"n"`
	Verifier  string `json:"v"`
	Return    string `json:"r,omitempty"`
	TestToken string `json:"t,omitempty"`
	Expires   int64  `json:"e"` // unix seconds
	// Binding binds the flow to one issuer + client id, so a flow started
	// with one configuration can't be finished with another.
	Binding string `json:"b"`
}

type provider struct {
	cfg      Config
	client   *http.Client
	oauth    oauth2.Config
	verifier *gooidc.IDTokenVerifier
	binding  string
}

func newProvider(ctx context.Context, cfg Config, client *http.Client) (*Provider, error) {
	cfg, err := normalizeConfig(cfg)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: defaultHTTPTimeout}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	op, err := gooidc.NewProvider(gooidc.ClientContext(ctx, client), cfg.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc: discovery for %q: %w", cfg.Issuer, err)
	}
	impl := &provider{
		cfg:    cfg,
		client: client,
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			Endpoint:     op.Endpoint(),
			RedirectURL:  cfg.RedirectURL,
			Scopes:       cfg.Scopes,
		},
		verifier: op.Verifier(&gooidc.Config{ClientID: cfg.ClientID, Now: func() time.Time { return now() }}),
		binding:  cfg.Issuer + "\x00" + cfg.ClientID,
	}
	return &Provider{cfg: cfg, impl: impl}, nil
}

// normalizeConfig validates cfg and fills in defaults.
func normalizeConfig(cfg Config) (Config, error) {
	cfg.Issuer = strings.TrimSpace(cfg.Issuer)
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	cfg.GroupsClaim = strings.TrimSpace(cfg.GroupsClaim)

	if cfg.Issuer == "" {
		return cfg, fmt.Errorf("oidc: issuer is required: %w", ErrNotConfigured)
	}
	if !isAbsHTTPURL(cfg.Issuer) {
		return cfg, fmt.Errorf("oidc: issuer must be an absolute http(s) URL: %w", ErrNotConfigured)
	}
	if cfg.ClientID == "" {
		return cfg, fmt.Errorf("oidc: client id is required: %w", ErrNotConfigured)
	}
	if cfg.RedirectURL == "" || !isAbsHTTPURL(cfg.RedirectURL) {
		return cfg, fmt.Errorf("oidc: redirect URL must be an absolute http(s) URL: %w", ErrNotConfigured)
	}
	if cfg.GroupsClaim == "" {
		cfg.GroupsClaim = "groups"
	}

	scopes := []string{gooidc.ScopeOpenID}
	seen := map[string]bool{gooidc.ScopeOpenID: true}
	src := cfg.Scopes
	if len(src) == 0 {
		src = []string{"email", "profile"}
	}
	for _, s := range src {
		for _, f := range strings.Fields(s) {
			if !seen[f] {
				seen[f] = true
				scopes = append(scopes, f)
			}
		}
	}
	cfg.Scopes = scopes
	cfg.AllowedEmails = cleanList(cfg.AllowedEmails)
	cfg.AllowedGroups = cleanList(cfg.AllowedGroups)
	return cfg, nil
}

func cleanList(in []string) []string {
	var out []string
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func isAbsHTTPURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

// randomString returns randomBytes of crypto/rand as unpadded base64url.
func randomString() (string, error) {
	b := make([]byte, randomBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SanitizeReturnPath returns p if it is a same-origin relative path
// (starts with a single "/", not "//" or "/\", no scheme, no control
// characters), else "/".
func SanitizeReturnPath(p string) string {
	if p == "" || p[0] != '/' {
		return "/"
	}
	if len(p) > 1 && (p[1] == '/' || p[1] == '\\') {
		return "/"
	}
	for _, c := range p {
		if c < 0x20 || c == 0x7f || c == '\\' {
			return "/"
		}
	}
	u, err := url.Parse(p)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil {
		return "/"
	}
	return p
}

func (p *provider) start(w http.ResponseWriter, r *http.Request, s Signer, returnPath, testToken string, secure bool) (string, error) {
	if s == nil {
		return "", fmt.Errorf("oidc: no signer: %w", ErrNotConfigured)
	}
	var vals [3]string
	for i := range vals {
		v, err := randomString()
		if err != nil {
			return "", fmt.Errorf("oidc: random: %w", err)
		}
		vals[i] = v
	}
	st := flowState{
		State:     vals[0],
		Nonce:     vals[1],
		Verifier:  vals[2],
		Return:    SanitizeReturnPath(returnPath),
		TestToken: testToken,
		Expires:   now().Add(FlowTTL).Unix(),
		Binding:   p.binding,
	}
	payload, err := json.Marshal(st)
	if err != nil {
		return "", fmt.Errorf("oidc: encode flow: %w", err)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     FlowCookie,
		Value:    s.Sign(payload),
		Path:     flowCookiePath,
		MaxAge:   int(FlowTTL / time.Second),
		Expires:  now().Add(FlowTTL),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
	return p.oauth.AuthCodeURL(st.State,
		gooidc.Nonce(st.Nonce),
		oauth2.S256ChallengeOption(st.Verifier),
	), nil
}

func clearFlowCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     FlowCookie,
		Value:    "",
		Path:     flowCookiePath,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

// readFlow reads and verifies the flow cookie. It does not check the binding.
func readFlow(r *http.Request, s Signer) (flowState, error) {
	var st flowState
	if s == nil {
		return st, fmt.Errorf("oidc: no signer: %w", ErrNotConfigured)
	}
	c, err := r.Cookie(FlowCookie)
	if err != nil || c.Value == "" {
		return st, fmt.Errorf("oidc: no flow cookie: %w", ErrState)
	}
	payload, ok := s.Verify(c.Value)
	if !ok {
		return st, fmt.Errorf("oidc: bad flow cookie signature: %w", ErrState)
	}
	if err := json.Unmarshal(payload, &st); err != nil || st.State == "" || st.Nonce == "" || st.Verifier == "" {
		return flowState{}, fmt.Errorf("oidc: malformed flow cookie: %w", ErrState)
	}
	if now().Unix() >= st.Expires {
		return flowState{}, fmt.Errorf("oidc: flow started too long ago: %w", ErrFlowExpired)
	}
	return st, nil
}

// FlowTestToken returns the test token of the login flow carried by r (the
// callback request), or "" if there is none or the flow cookie is missing,
// invalid or expired. It does not consume the flow; the HTTP layer can use it
// to pick the provider (saved settings vs. settings under test) before
// calling Finish.
func FlowTestToken(r *http.Request, s Signer) string {
	st, err := readFlow(r, s)
	if err != nil {
		return ""
	}
	return st.TestToken
}

// FlowInfo returns the test token (an opaque intent for the HTTP layer) and
// the sanitized return path of the flow carried by r; ok=false if there is
// no valid, unexpired flow cookie. Works for flows started by the github
// package too (same cookie shape). It does not consume the flow.
func FlowInfo(r *http.Request, s Signer) (testToken, returnPath string, ok bool) {
	st, err := readFlow(r, s)
	if err != nil {
		return "", "", false
	}
	return st.TestToken, SanitizeReturnPath(st.Return), true
}

// idClaims are the ID token claims we use besides the standard ones.
type idClaims struct {
	Email             string `json:"email"`
	EmailVerified     any    `json:"email_verified"`
	PreferredUsername string `json:"preferred_username"`
	Name              string `json:"name"`
}

func (p *provider) finish(w http.ResponseWriter, r *http.Request, s Signer, secure bool) (Result, error) {
	clearFlowCookie(w, secure)

	st, err := readFlow(r, s)
	if err != nil {
		return Result{}, err
	}
	if subtle.ConstantTimeCompare([]byte(st.Binding), []byte(p.binding)) != 1 {
		return Result{}, fmt.Errorf("oidc: flow was started for another provider: %w", ErrState)
	}

	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		return Result{}, fmt.Errorf("oidc: provider returned error %q (%s): %w",
			clip(e, 64), clip(q.Get("error_description"), 200), ErrIdP)
	}
	got := q.Get("state")
	if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(st.State)) != 1 {
		return Result{}, fmt.Errorf("oidc: state does not match: %w", ErrState)
	}
	// RFC 9207: if the IdP names itself, it must be our issuer.
	if iss := q.Get("iss"); iss != "" && iss != p.cfg.Issuer {
		return Result{}, fmt.Errorf("oidc: callback issuer %q does not match: %w", clip(iss, 200), ErrState)
	}
	code := q.Get("code")
	if code == "" {
		return Result{}, fmt.Errorf("oidc: no code in callback: %w", ErrExchange)
	}

	ctx := gooidc.ClientContext(r.Context(), p.client)
	ctx = context.WithValue(ctx, oauth2.HTTPClient, p.client)
	tok, err := p.oauth.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return Result{}, fmt.Errorf("oidc: code exchange: %v: %w", err, ErrExchange)
	}
	raw, _ := tok.Extra("id_token").(string)
	if raw == "" {
		return Result{}, fmt.Errorf("oidc: token response has no id_token: %w", ErrToken)
	}
	idt, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		return Result{}, fmt.Errorf("oidc: id token: %v: %w", err, ErrToken)
	}
	if subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(st.Nonce)) != 1 {
		return Result{}, fmt.Errorf("oidc: nonce does not match: %w", ErrNonce)
	}

	var c idClaims
	all := map[string]any{}
	if err := idt.Claims(&c); err != nil {
		return Result{}, fmt.Errorf("oidc: id token claims: %v: %w", err, ErrToken)
	}
	if err := idt.Claims(&all); err != nil {
		return Result{}, fmt.Errorf("oidc: id token claims: %v: %w", err, ErrToken)
	}

	id := Identity{
		Email:  strings.TrimSpace(c.Email),
		Groups: groupsFrom(all[p.cfg.GroupsClaim]),
	}
	switch {
	case id.Email != "":
		id.User = id.Email
	case strings.TrimSpace(c.PreferredUsername) != "":
		id.User = strings.TrimSpace(c.PreferredUsername)
	default:
		id.User = idt.Subject
	}
	if id.User == "" {
		return Result{}, fmt.Errorf("oidc: id token has no subject: %w", ErrToken)
	}

	verified, present := boolClaim(c.EmailVerified)
	id.Issuer, id.Subject = idt.Issuer, idt.Subject
	id.EmailVerified, id.EmailVerifiedPresent = verified, present
	id.Name = strings.TrimSpace(c.Name)
	id.PreferredUsername = strings.TrimSpace(c.PreferredUsername)
	if id.Subject == "" {
		return Result{}, fmt.Errorf("oidc: id token has no subject: %w", ErrToken)
	}
	emailUsable := id.EmailUsable(p.cfg.AllowUnverifiedEmail)
	if err := p.checkAllowed(id, emailUsable); err != nil {
		return Result{}, err
	}

	return Result{Identity: id, ReturnPath: SanitizeReturnPath(st.Return), TestToken: st.TestToken}, nil
}

// checkAllowed applies the allow-lists. With both lists set, matching
// either one is enough.
func (p *provider) checkAllowed(id Identity, emailUsable bool) error {
	emails, groups := p.cfg.AllowedEmails, p.cfg.AllowedGroups
	if len(emails) == 0 && len(groups) == 0 {
		return nil
	}
	if len(emails) > 0 && emailUsable && containsFold(emails, id.Email) {
		return nil
	}
	if len(groups) > 0 {
		for _, g := range id.Groups {
			if containsFold(groups, g) {
				return nil
			}
		}
	}
	if len(emails) > 0 && id.Email != "" && !emailUsable {
		return fmt.Errorf("oidc: e-mail %q is not verified: %w", id.Email, ErrNotAllowed)
	}
	return fmt.Errorf("oidc: %q is not in the allow-list: %w", id.User, ErrNotAllowed)
}

func containsFold(list []string, v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	for _, s := range list {
		if strings.EqualFold(s, v) {
			return true
		}
	}
	return false
}

// groupsFrom accepts a string array or a single string.
func groupsFrom(v any) []string {
	switch g := v.(type) {
	case string:
		if g = strings.TrimSpace(g); g != "" {
			return []string{g}
		}
	case []any:
		var out []string
		for _, e := range g {
			if s, ok := e.(string); ok && strings.TrimSpace(s) != "" {
				out = append(out, strings.TrimSpace(s))
			}
		}
		return out
	}
	return nil
}

// boolClaim interprets email_verified, which some IdPs send as a string.
// present is false if the claim is absent (or null).
func boolClaim(v any) (value, present bool) {
	switch b := v.(type) {
	case nil:
		return false, false
	case bool:
		return b, true
	case string:
		return strings.EqualFold(strings.TrimSpace(b), "true"), true
	default:
		return false, true // unknown shape: treat as not verified
	}
}

func clip(s string, n int) string {
	if len(s) > n {
		s = s[:n]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

var _ providerImpl = (*provider)(nil)
