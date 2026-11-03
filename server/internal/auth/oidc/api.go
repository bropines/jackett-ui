// Package oidc implements the OpenID Connect login for jackett-ui:
// authorization code flow with PKCE (S256), state and nonce, ID token
// verification (go-oidc), and e-mail / group allow-lists.
//
// The HTTP wiring (routes, sessions, settings) lives in internal/httpapi; this
// package only knows how to start a login and how to finish it.
package oidc

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Config is one OIDC client configuration.
type Config struct {
	Issuer        string
	ClientID      string
	ClientSecret  string
	Scopes        []string // default: openid email profile
	AllowedEmails []string // empty: any user of the IdP
	AllowedGroups []string // empty: no group check
	GroupsClaim   string   // default: groups
	RedirectURL   string   // absolute, …/_ui/auth/oidc/callback
}

// Identity is the result of a successful login.
type Identity struct {
	User   string // email, else preferred_username, else sub
	Email  string
	Groups []string
}

// Signer signs and verifies small opaque values (the flow cookie). The
// httpapi package passes its session signer.
type Signer interface {
	Sign(payload []byte) string
	Verify(token string) ([]byte, bool)
}

// FlowCookie is the name of the short-lived cookie that carries state,
// nonce, PKCE verifier, return path and test token between Start and Finish.
const FlowCookie = "jui_oidc"

// FlowTTL is how long a started login stays valid.
const FlowTTL = 10 * time.Minute

// Errors returned by Finish. httpapi maps them to ?authError=<code>.
var (
	ErrState         = errors.New("state_mismatch")
	ErrExchange      = errors.New("code_exchange_failed")
	ErrToken         = errors.New("invalid_id_token")
	ErrNonce         = errors.New("nonce_mismatch")
	ErrNotAllowed    = errors.New("user_not_allowed")
	ErrIdP           = errors.New("idp_error") // the IdP redirected back with ?error=
	ErrFlowExpired   = errors.New("flow_expired")
	ErrNotConfigured = errors.New("oidc_not_configured")
)

// Provider is a discovered OIDC provider for one Config.
type Provider struct {
	cfg  Config
	impl providerImpl
}

// providerImpl is filled in by the implementation (provider.go).
type providerImpl interface {
	start(w http.ResponseWriter, r *http.Request, s Signer, returnPath, testToken string, secure bool) (redirect string, err error)
	finish(w http.ResponseWriter, r *http.Request, s Signer, secure bool) (Result, error)
}

// Result of Finish.
type Result struct {
	Identity   Identity
	ReturnPath string // same-origin relative path, "/" if none or unsafe
	TestToken  string // non-empty for the settings "test login" flow
}

// New runs OIDC discovery for cfg.Issuer (with the given HTTP client, nil = default
// with a 10 s timeout) and returns a Provider. It fails if discovery fails or
// required fields are missing.
func New(ctx context.Context, cfg Config, client *http.Client) (*Provider, error) {
	return newProvider(ctx, cfg, client)
}

// Start begins a login: it stores the flow cookie and returns the IdP URL to
// redirect to. returnPath must be a same-origin relative path (others are
// replaced with "/"). testToken is passed through to Result.TestToken.
// secure sets the cookie's Secure flag.
func (p *Provider) Start(w http.ResponseWriter, r *http.Request, s Signer, returnPath, testToken string, secure bool) (string, error) {
	return p.impl.start(w, r, s, returnPath, testToken, secure)
}

// Finish completes a login on the callback request: checks state, exchanges
// the code (PKCE), verifies the ID token and nonce, applies the allow-lists,
// clears the flow cookie and returns the identity.
func (p *Provider) Finish(w http.ResponseWriter, r *http.Request, s Signer, secure bool) (Result, error) {
	return p.impl.finish(w, r, s, secure)
}

// Config returns the configuration the provider was built from.
func (p *Provider) Config() Config { return p.cfg }
