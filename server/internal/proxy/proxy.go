// Package proxy forwards Jackett paths to JACKETT_URL.
//
// Header hygiene: the browser's Cookie header is always removed and
// Set-Cookie from Jackett is always dropped, so Jackett only ever sees the
// server's own cookie, and only for authenticated requests (never for the
// public API-key routes). On a login challenge from Jackett the server
// re-logs in (coalesced) and retries the request once.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/jackett"
)

// Options describe one proxied request.
type Options struct {
	// Path is the cleaned request path (the one the routing decision was
	// made on); it is what Jackett receives.
	Path string
	// WithCookie attaches the server's Jackett cookie (authenticated
	// requests). Must be false for the public API-key routes.
	WithCookie bool
	// Forwarded values (effective, only from trusted proxies).
	Proto, Host, For string
}

type ctxKey struct{}

// Proxy is the Jackett reverse proxy.
type Proxy struct {
	jc  *jackett.Client
	rp  *httputil.ReverseProxy
	log *slog.Logger

	// MaxBody limits request bodies (like nginx client_max_body_size 4m).
	MaxBody int64
	// Timeout for normal requests; SearchTimeout for …/results paths.
	Timeout       time.Duration
	SearchTimeout time.Duration
}

// New returns a proxy to jc's base URL. transport nil = a default transport.
func New(jc *jackett.Client, transport http.RoundTripper, log *slog.Logger) *Proxy {
	if transport == nil {
		transport = &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			MaxIdleConns:          32,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       90 * time.Second,
			DisableCompression:    true, // pass Jackett's encoding through
			ExpectContinueTimeout: time.Second,
		}
	}
	if log == nil {
		log = slog.Default()
	}
	p := &Proxy{jc: jc, log: log, MaxBody: 4 << 20, Timeout: 60 * time.Second, SearchTimeout: 180 * time.Second}
	base := jc.Base()
	p.rp = &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			o := pr.In.Context().Value(ctxKey{}).(Options)
			out := pr.Out
			out.URL.Scheme = base.Scheme
			out.URL.Host = base.Host
			out.URL.Path = strings.TrimRight(base.Path, "/") + o.Path
			out.URL.RawPath = ""
			out.URL.RawQuery = pr.In.URL.RawQuery
			out.Host = o.Host
			out.Header.Del("Cookie")
			out.Header.Del("X-Real-Ip")
			out.Header.Del("Forwarded")
			if o.For != "" {
				out.Header.Set("X-Forwarded-For", o.For)
				out.Header.Set("X-Real-IP", lastIP(o.For))
			}
			if o.Proto != "" {
				out.Header.Set("X-Forwarded-Proto", o.Proto)
			}
			if o.Host != "" {
				out.Header.Set("X-Forwarded-Host", o.Host)
			}
		},
		Transport: &retryTransport{base: transport, jc: jc},
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Set-Cookie")
			// The front sets these for every response; don't send two.
			for _, h := range []string{"X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Content-Security-Policy"} {
				resp.Header.Del(h)
			}
			return nil
		},
		ErrorHandler: p.errorHandler,
		ErrorLog:     slog.NewLogLogger(log.Handler(), slog.LevelDebug),
	}
	return p
}

func lastIP(xff string) string {
	if i := strings.LastIndexByte(xff, ','); i >= 0 {
		return strings.TrimSpace(xff[i+1:])
	}
	return strings.TrimSpace(xff)
}

// IsSearchPath reports whether the path gets the long (search) timeout.
func IsSearchPath(p string) bool {
	return strings.Contains(strings.ToLower(p), "/results")
}

// ServeHTTP is not used directly; call Serve with options.
func (p *Proxy) Serve(w http.ResponseWriter, r *http.Request, o Options) {
	timeout := p.Timeout
	if IsSearchPath(o.Path) {
		timeout = p.SearchTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	ctx = context.WithValue(ctx, ctxKey{}, o)
	r = r.WithContext(ctx)

	if r.Body != nil && r.Body != http.NoBody {
		// Buffer the body so the request can be retried after a re-login.
		body, err := io.ReadAll(io.LimitReader(r.Body, p.MaxBody+1))
		_ = r.Body.Close()
		if err != nil {
			WriteError(w, http.StatusBadRequest, "bad_request", "Не удалось прочитать тело запроса")
			return
		}
		if int64(len(body)) > p.MaxBody {
			WriteError(w, http.StatusRequestEntityTooLarge, "body_too_large", "Слишком большой запрос")
			return
		}
		r.ContentLength = int64(len(body))
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
		if len(body) == 0 {
			r.Body = http.NoBody
		}
	}
	p.rp.ServeHTTP(w, r)
}

func (p *Proxy) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, jackett.ErrLoginFailed):
		WriteError(w, http.StatusBadGateway, "jackett_login_failed", "Jackett не принял пароль администратора (JACKETT_PASSWORD)")
	case errors.Is(err, context.Canceled) && r.Context().Err() != nil && !errors.Is(r.Context().Err(), context.DeadlineExceeded):
		// The client went away; nothing to answer.
		w.WriteHeader(499)
	case errors.Is(err, context.DeadlineExceeded):
		p.log.Warn("jackett request timed out", "path", r.URL.Path)
		WriteError(w, http.StatusGatewayTimeout, "jackett_timeout", "Jackett не ответил вовремя")
	default:
		p.log.Warn("jackett unreachable", "path", r.URL.Path, "error", err)
		WriteError(w, http.StatusBadGateway, "jackett_unreachable", "Jackett недоступен")
	}
}

// WriteError writes the JSON error shape {"error","message"}.
func WriteError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": msg})
}

// retryTransport attaches the Jackett cookie and retries once after a
// re-login.
type retryTransport struct {
	base http.RoundTripper
	jc   *jackett.Client
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	o, _ := req.Context().Value(ctxKey{}).(Options)
	if !o.WithCookie {
		req.Header.Del("Cookie")
		return t.base.RoundTrip(req)
	}
	cookie, gen := t.jc.Cookie()
	resp, err := t.base.RoundTrip(withCookie(req, cookie, false))
	if err != nil || !jackett.IsLoginChallenge(resp) {
		return resp, err
	}
	drain(resp)
	if err := t.jc.Relogin(req.Context(), gen); err != nil {
		return nil, err
	}
	cookie, _ = t.jc.Cookie()
	retry, err := cloneWithBody(req)
	if err != nil {
		return nil, err
	}
	resp, err = t.base.RoundTrip(withCookie(retry, cookie, true))
	if err != nil {
		return nil, err
	}
	if jackett.IsLoginChallenge(resp) {
		drain(resp)
		return nil, jackett.ErrLoginFailed
	}
	return resp, nil
}

func withCookie(req *http.Request, cookie string, cloned bool) *http.Request {
	if !cloned {
		r2 := req.Clone(req.Context())
		r2.Body = req.Body
		req = r2
	}
	req.Header.Del("Cookie")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	return req
}

func cloneWithBody(req *http.Request) (*http.Request, error) {
	r2 := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return nil, errors.New("proxy: request body cannot be replayed")
		}
		b, err := req.GetBody()
		if err != nil {
			return nil, err
		}
		r2.Body = b
	}
	return r2, nil
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	_ = resp.Body.Close()
}
