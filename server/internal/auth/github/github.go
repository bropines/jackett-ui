// Package github implements login with GitHub (plain OAuth2: GitHub has no
// OIDC for user sign-in). The identity comes from the REST API: GET /user and
// GET /user/emails (primary + verified only). Same Start/Finish shape and the
// same flow cookie as internal/auth/oidc, so the HTTP layer treats all
// providers alike.
package github

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"github.com/bropines/jackett-ui/server/internal/auth/oidc"
)

// Endpoints of GitHub (overridable in tests).
type Endpoints struct {
	AuthURL  string
	TokenURL string
	APIURL   string // base for /user and /user/emails
}

// Default are the public github.com endpoints.
var Default = Endpoints{
	AuthURL:  "https://github.com/login/oauth/authorize",
	TokenURL: "https://github.com/login/oauth/access_token",
	APIURL:   "https://api.github.com",
}

// Scopes requested from GitHub: read the profile and the e-mail addresses.
var Scopes = []string{"read:user", "user:email"}

// Config of the GitHub OAuth App.
type Config struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string // absolute, …/_ui/auth/github/callback
	Endpoints    Endpoints
}

// Identity of a GitHub user.
type Identity struct {
	Login string // lower-cased
	Email string // primary verified e-mail, lower-cased; "" if none
	ID    int64
	Name  string
}

// User is the display/session name: the e-mail if known, else the login.
func (i Identity) User() string {
	if i.Email != "" {
		return i.Email
	}
	return i.Login
}

// Result of Finish.
type Result struct {
	Identity   Identity
	ReturnPath string
	TestToken  string
}

// Provider is a configured GitHub login.
type Provider struct {
	cfg     Config
	oauth   oauth2.Config
	client  *http.Client
	binding string
}

const httpTimeout = 10 * time.Second

// now is replaceable in tests.
var now = time.Now

// New validates cfg and returns a Provider (no network calls).
func New(cfg Config, client *http.Client) (*Provider, error) {
	cfg.ClientID = strings.TrimSpace(cfg.ClientID)
	cfg.RedirectURL = strings.TrimSpace(cfg.RedirectURL)
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return nil, fmt.Errorf("github: client id and secret are required: %w", oidc.ErrNotConfigured)
	}
	if u, err := url.Parse(cfg.RedirectURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("github: redirect URL must be an absolute http(s) URL: %w", oidc.ErrNotConfigured)
	}
	if cfg.Endpoints == (Endpoints{}) {
		cfg.Endpoints = Default
	}
	if client == nil {
		client = &http.Client{Timeout: httpTimeout}
	}
	return &Provider{
		cfg:    cfg,
		client: client,
		oauth: oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Scopes:       Scopes,
			Endpoint:     oauth2.Endpoint{AuthURL: cfg.Endpoints.AuthURL, TokenURL: cfg.Endpoints.TokenURL, AuthStyle: oauth2.AuthStyleInParams},
		},
		binding: "github\x00" + cfg.ClientID,
	}, nil
}

// Config returns the configuration the provider was built from.
func (p *Provider) Config() Config { return p.cfg }

// flowState has the same JSON shape as the oidc package's flow cookie, so
// oidc.FlowTestToken works for both. Nonce is unused (no ID token).
type flowState struct {
	State     string `json:"s"`
	Nonce     string `json:"n"`
	Verifier  string `json:"v"`
	Return    string `json:"r,omitempty"`
	TestToken string `json:"t,omitempty"`
	Expires   int64  `json:"e"`
	Binding   string `json:"b"`
}

const cookiePath = "/_ui/auth/"

func random() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Start stores the flow cookie and returns the GitHub authorization URL
// (state + PKCE S256).
func (p *Provider) Start(w http.ResponseWriter, _ *http.Request, s oidc.Signer, returnPath, testToken string, secure bool) (string, error) {
	if s == nil {
		return "", fmt.Errorf("github: no signer: %w", oidc.ErrNotConfigured)
	}
	state, err := random()
	if err != nil {
		return "", err
	}
	verifier, err := random()
	if err != nil {
		return "", err
	}
	st := flowState{State: state, Nonce: "-", Verifier: verifier, Return: oidc.SanitizeReturnPath(returnPath),
		TestToken: testToken, Expires: now().Add(oidc.FlowTTL).Unix(), Binding: p.binding}
	payload, _ := json.Marshal(st)
	http.SetCookie(w, &http.Cookie{Name: oidc.FlowCookie, Value: s.Sign(payload), Path: cookiePath,
		MaxAge: int(oidc.FlowTTL / time.Second), Expires: now().Add(oidc.FlowTTL), HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
	return p.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("allow_signup", "false")), nil
}

func clear(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{Name: oidc.FlowCookie, Value: "", Path: cookiePath, MaxAge: -1,
		Expires: time.Unix(0, 0), HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode})
}

// Finish completes the login on the callback request.
func (p *Provider) Finish(w http.ResponseWriter, r *http.Request, s oidc.Signer, secure bool) (Result, error) {
	clear(w, secure)
	var st flowState
	c, err := r.Cookie(oidc.FlowCookie)
	if err != nil || c.Value == "" || s == nil {
		return Result{}, fmt.Errorf("github: no flow cookie: %w", oidc.ErrState)
	}
	payload, ok := s.Verify(c.Value)
	if !ok || json.Unmarshal(payload, &st) != nil || st.State == "" || st.Verifier == "" {
		return Result{}, fmt.Errorf("github: bad flow cookie: %w", oidc.ErrState)
	}
	if subtle.ConstantTimeCompare([]byte(st.Binding), []byte(p.binding)) != 1 {
		return Result{}, fmt.Errorf("github: flow started by another provider: %w", oidc.ErrState)
	}
	if now().Unix() >= st.Expires {
		return Result{}, fmt.Errorf("github: flow expired: %w", oidc.ErrFlowExpired)
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		return Result{}, fmt.Errorf("github: %s: %w", clip(e), oidc.ErrIdP)
	}
	if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(st.State)) != 1 {
		return Result{}, fmt.Errorf("github: state does not match: %w", oidc.ErrState)
	}
	code := q.Get("code")
	if code == "" {
		return Result{}, fmt.Errorf("github: no code: %w", oidc.ErrExchange)
	}
	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, p.client)
	tok, err := p.oauth.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil || tok.AccessToken == "" {
		return Result{}, fmt.Errorf("github: code exchange: %v: %w", err, oidc.ErrExchange)
	}
	id, err := p.identity(r.Context(), tok.AccessToken)
	if err != nil {
		return Result{}, fmt.Errorf("github: profile: %v: %w", err, oidc.ErrToken)
	}
	return Result{Identity: id, ReturnPath: st.Return, TestToken: st.TestToken}, nil
}

func clip(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > 100 {
		s = s[:100]
	}
	return s
}

func (p *Provider) getJSON(ctx context.Context, path, token string, dst any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.cfg.Endpoints.APIURL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
		return fmt.Errorf("%s: HTTP %d", path, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(dst)
}

// identity reads the user and the primary verified e-mail.
func (p *Provider) identity(ctx context.Context, token string) (Identity, error) {
	var u struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
		Name  string `json:"name"`
	}
	if err := p.getJSON(ctx, "/user", token, &u); err != nil {
		return Identity{}, err
	}
	if u.ID <= 0 || u.Login == "" {
		return Identity{}, errors.New("missing id/login")
	}
	id := Identity{Login: strings.ToLower(u.Login), ID: u.ID, Name: u.Name}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	// Needs user:email; without it only the login can be matched.
	if err := p.getJSON(ctx, "/user/emails", token, &emails); err == nil {
		for _, e := range emails {
			if e.Primary && e.Verified {
				id.Email = strings.ToLower(strings.TrimSpace(e.Email))
				break
			}
		}
	}
	return id, nil
}

// Issuer is the identity issuer recorded for GitHub accounts.
const Issuer = "https://github.com"

// Subject is the stable account key: the numeric user id (logins can be renamed).
func (i Identity) Subject() string { return strconv.FormatInt(i.ID, 10) }

// String helps logging without leaking anything sensitive.
func (i Identity) String() string { return i.Login + "#" + strconv.FormatInt(i.ID, 10) }
