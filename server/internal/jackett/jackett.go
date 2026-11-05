// Package jackett logs in to Jackett on behalf of the browser and keeps the
// resulting cookie. Login is POST /UI/Dashboard with the admin password
// (redirect not followed); success is confirmed by probing
// /api/v2.0/server/config, which also yields Jackett's version.
//
// Re-logins (after a 401 or a redirect to /UI/Login) are coalesced: callers
// pass the generation of the cookie they used; if a newer login already
// happened they just retry with the new cookie, and concurrent callers wait
// for the one login in flight.
package jackett

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Errors.
var (
	// ErrLoginFailed: Jackett rejected JACKETT_PASSWORD.
	ErrLoginFailed = errors.New("jackett_login_failed")
	// ErrUnreachable: Jackett could not be reached or answered unexpectedly.
	ErrUnreachable = errors.New("jackett_unreachable")
)

// Status is what /_ui/api/auth/state reports.
type Status struct {
	OK      bool   `json:"ok"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Client is the Jackett session holder.
type Client struct {
	base     *url.URL
	password string
	hc       *http.Client
	log      *slog.Logger

	// FailBackoff: after a failed login, further re-login requests within
	// this window fail fast with the same error (no login storm when the
	// password is wrong).
	FailBackoff time.Duration
	// StatusTTL caches Status results.
	StatusTTL time.Duration
	// LoginTimeout bounds one login (POST + probe).
	LoginTimeout time.Duration
	// KeyTTL: how long the API key read from server/config is used before
	// it is read again.
	KeyTTL time.Duration

	mu        sync.Mutex
	cookies   []*http.Cookie
	gen       uint64
	inflight  chan struct{}
	lastErr   error
	lastTry   time.Time
	version   string
	apiKey    string
	keyAt     time.Time
	status    Status
	statusAt  time.Time
	statusSet bool
}

// New returns a client for base (JACKETT_URL). transport nil = default.
func New(base *url.URL, password string, transport http.RoundTripper, log *slog.Logger) *Client {
	if transport == nil {
		transport = http.DefaultTransport
	}
	if log == nil {
		log = slog.Default()
	}
	return &Client{
		base:     base,
		password: password,
		hc: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		log:          log,
		FailBackoff:  5 * time.Second,
		StatusTTL:    15 * time.Second,
		LoginTimeout: 15 * time.Second,
		KeyTTL:       5 * time.Minute,
	}
}

// Base returns Jackett's base URL.
func (c *Client) Base() *url.URL { return c.base }

// Cookie returns the Cookie header value to send to Jackett ("" if none)
// and the generation it belongs to.
func (c *Client) Cookie() (string, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	parts := make([]string, 0, len(c.cookies))
	for _, ck := range c.cookies {
		parts = append(parts, ck.Name+"="+ck.Value)
	}
	return strings.Join(parts, "; "), c.gen
}

// Relogin logs in again unless a login newer than seenGen already happened.
// Concurrent callers share one login.
func (c *Client) Relogin(ctx context.Context, seenGen uint64) error {
	c.mu.Lock()
	if c.gen != seenGen {
		err := c.lastErr
		c.mu.Unlock()
		return err
	}
	if ch := c.inflight; ch != nil {
		c.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
		c.mu.Lock()
		err := c.lastErr
		c.mu.Unlock()
		return err
	}
	if c.lastErr != nil && time.Since(c.lastTry) < c.FailBackoff {
		err := c.lastErr
		c.mu.Unlock()
		return err
	}
	ch := make(chan struct{})
	c.inflight = ch
	c.mu.Unlock()

	// Detached from the caller: one cancelled request must not fail the
	// login for everyone waiting on it.
	lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.LoginTimeout)
	cookies, version, err := c.login(lctx)
	cancel()

	c.mu.Lock()
	if err == nil {
		c.cookies = cookies
		c.version = version
		c.status = Status{OK: true, Version: version}
	} else {
		c.status = Status{OK: false, Error: errCode(err)}
	}
	c.statusAt, c.statusSet = time.Now(), true
	c.lastErr = err
	c.lastTry = time.Now()
	c.gen++
	c.inflight = nil
	close(ch)
	c.mu.Unlock()

	if err != nil {
		c.log.Warn("jackett login failed", "error", err)
	} else {
		c.log.Debug("jackett login ok", "version", version)
	}
	return err
}

func errCode(err error) string {
	if errors.Is(err, ErrLoginFailed) {
		return ErrLoginFailed.Error()
	}
	return ErrUnreachable.Error()
}

// Status returns Jackett's state, cached for StatusTTL. A probe that gets a
// login challenge triggers a (coalesced) re-login.
func (c *Client) Status(ctx context.Context) Status {
	c.mu.Lock()
	if c.statusSet && time.Since(c.statusAt) < c.StatusTTL {
		s := c.status
		c.mu.Unlock()
		return s
	}
	c.mu.Unlock()

	cookie, gen := c.Cookie()
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	version, challenged, err := c.probe(pctx, cookie)
	cancel()
	var st Status
	switch {
	case err != nil:
		st = Status{OK: false, Error: errCode(err)}
	case challenged:
		if err := c.Relogin(ctx, gen); err != nil {
			st = Status{OK: false, Error: errCode(err)}
		} else {
			c.mu.Lock()
			st = Status{OK: true, Version: c.version}
			c.mu.Unlock()
		}
	default:
		st = Status{OK: true, Version: version}
	}
	c.mu.Lock()
	c.status, c.statusAt, c.statusSet = st, time.Now(), true
	if st.OK && st.Version != "" {
		c.version = st.Version
	}
	c.mu.Unlock()
	return st
}

// endpoint joins the base path and p.
func (c *Client) endpoint(p string) string {
	u := *c.base
	u.Path = strings.TrimRight(c.base.Path, "/") + p
	u.RawPath = ""
	return u.String()
}

func (c *Client) login(ctx context.Context) ([]*http.Cookie, string, error) {
	form := url.Values{"password": {c.password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("/UI/Dashboard"), strings.NewReader(form.Encode()))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	resp.Body.Close()
	if resp.StatusCode >= 500 {
		return nil, "", fmt.Errorf("%w: login answered %d", ErrUnreachable, resp.StatusCode)
	}
	var cookies []*http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Value == "" || ck.MaxAge < 0 {
			continue
		}
		cookies = append(cookies, &http.Cookie{Name: ck.Name, Value: ck.Value})
	}
	parts := make([]string, 0, len(cookies))
	for _, ck := range cookies {
		parts = append(parts, ck.Name+"="+ck.Value)
	}
	version, challenged, err := c.probe(ctx, strings.Join(parts, "; "))
	if err != nil {
		return nil, "", err
	}
	if challenged {
		return nil, "", ErrLoginFailed
	}
	return cookies, version, nil
}

// probe calls /api/v2.0/server/config with cookie. challenged = Jackett
// wants a login.
func (c *Client) probe(ctx context.Context, cookie string) (version string, challenged bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("/api/v2.0/server/config"), nil)
	if err != nil {
		return "", false, err
	}
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set("Accept", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()
	if IsLoginChallenge(resp) {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return "", true, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("%w: server/config answered %d", ErrUnreachable, resp.StatusCode)
	}
	var cfg struct {
		AppVersion string `json:"app_version"`
		APIKey     string `json:"api_key"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&cfg); err != nil {
		return "", false, fmt.Errorf("%w: server/config: %v", ErrUnreachable, err)
	}
	if k := strings.TrimSpace(cfg.APIKey); k != "" {
		c.mu.Lock()
		c.apiKey, c.keyAt = k, time.Now()
		c.mu.Unlock()
	}
	v := cfg.AppVersion
	if v != "" && !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	return v, false, nil
}

// IsLoginChallenge reports whether Jackett asks for a login: 401, or a
// redirect to /UI/Login.
func IsLoginChallenge(resp *http.Response) bool {
	if resp.StatusCode == http.StatusUnauthorized {
		return true
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc := strings.ToLower(resp.Header.Get("Location"))
		if u, err := url.Parse(loc); err == nil {
			p := strings.TrimRight(u.Path, "/")
			return strings.HasSuffix(p, "/ui/login") || p == "login"
		}
	}
	return false
}

// APIKey returns Jackett's API key (read from server/config by the login
// probe), re-reading it when older than KeyTTL. The key never leaves the
// server: the proxy injects it upstream and scrubs it from responses. If a
// refresh fails, the last known key is returned (so scrubbing keeps working).
func (c *Client) APIKey(ctx context.Context) (string, error) {
	c.mu.Lock()
	k, at := c.apiKey, c.keyAt
	c.mu.Unlock()
	if k != "" && time.Since(at) < c.KeyTTL {
		return k, nil
	}
	c.mu.Lock()
	c.statusSet = false
	c.mu.Unlock()
	st := c.Status(ctx)
	c.mu.Lock()
	k = c.apiKey
	c.mu.Unlock()
	if k != "" {
		return k, nil
	}
	if st.Error == ErrLoginFailed.Error() {
		return "", ErrLoginFailed
	}
	return "", ErrUnreachable
}

// KnownAPIKey returns the last known API key without network I/O ("" if
// none yet).
func (c *Client) KnownAPIKey() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.apiKey
}

// InvalidateAPIKey makes the next APIKey call read the key again (after a
// change of Jackett's server settings).
func (c *Client) InvalidateAPIKey() {
	c.mu.Lock()
	c.keyAt = time.Time{}
	c.mu.Unlock()
}

// Do sends an authenticated API request to Jackett (path like
// "/api/v2.0/server/config") with the server's cookie, logging in again
// once on a login challenge. body is re-sent on the retry, so it is a
// byte slice. The caller closes the response body.
func (c *Client) Do(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		cookie, gen := c.Cookie()
		var rb io.Reader
		if body != nil {
			rb = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path), rb)
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
		}
		if !IsLoginChallenge(resp) || attempt > 0 {
			return resp, nil
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		_ = resp.Body.Close()
		if err := c.Relogin(ctx, gen); err != nil {
			return nil, err
		}
	}
}
