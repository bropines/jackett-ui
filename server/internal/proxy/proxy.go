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
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"strconv"
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
	// RawQuery, when non-nil, replaces the request's query string (the
	// caller strips API-key parameters and injects Jackett's key).
	RawQuery *string
	// Rewrite scrubs Jackett's API key from the response (nil = off).
	Rewrite *Rewrite
}

// Rewrite describes the response rewriting: every occurrence of Key in
// header values and in text bodies is replaced with Replacement.
type Rewrite struct {
	Key         string
	Replacement string
	// HideConfigKey replaces the "api_key" member of a JSON object body
	// with "(hidden)" (GET server/config).
	HideConfigKey bool
}

// DefaultMaxRewrite caps bodies that are buffered for rewriting.
const DefaultMaxRewrite = 64 << 20

// HiddenKey is what server/config's api_key becomes.
const HiddenKey = "(hidden)"

// Errors from response rewriting (mapped to 502 by the error handler).
var (
	ErrTooLarge = errors.New("response_too_large")
	errEncoding = errors.New("unsupported upstream content encoding")
	errUpgrade  = errors.New("protocol upgrade not supported")
)

type ctxKey struct{}

// Proxy is the Jackett reverse proxy.
type Proxy struct {
	jc  *jackett.Client
	rp  *httputil.ReverseProxy
	log *slog.Logger

	// MaxBody limits request bodies (like nginx client_max_body_size 4m).
	MaxBody int64
	// MaxRewrite caps response bodies buffered for rewriting.
	MaxRewrite int64
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
	p := &Proxy{jc: jc, log: log, MaxBody: 4 << 20, MaxRewrite: DefaultMaxRewrite, Timeout: 60 * time.Second, SearchTimeout: 180 * time.Second}
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
			if o.RawQuery != nil {
				out.URL.RawQuery = *o.RawQuery
			}
			out.Host = o.Host
			out.Header.Del("Cookie")
			out.Header.Del("X-Real-Ip")
			out.Header.Del("Forwarded")
			out.Header.Del("X-Api-Key")
			if o.Rewrite != nil {
				// The whole body is needed to scrub the key: no ranges,
				// and only encodings we can decode.
				out.Header.Del("Range")
				out.Header.Del("If-Range")
				out.Header.Set("Accept-Encoding", "gzip")
			}
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
			if resp.StatusCode == http.StatusSwitchingProtocols {
				return errUpgrade
			}
			o, _ := resp.Request.Context().Value(ctxKey{}).(Options)
			if o.Rewrite != nil {
				return rewriteResponse(resp, o.Rewrite, p.MaxRewrite)
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
	// No protocol upgrades through the proxy (a tunnel can't be scrubbed).
	r.Header.Del("Upgrade")
	p.rp.ServeHTTP(w, r)
}

// passThroughType: binary bodies that are never rewritten.
func passThroughType(ct string) bool {
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return false
	}
	return mt == "application/x-bittorrent" || strings.HasPrefix(mt, "image/")
}

// rewriteResponse scrubs rw.Key from the response headers and (for
// non-binary types) the body: gzip is decoded, the body is buffered up to
// limit, the key replaced, and the result sent uncompressed (the front's
// gzip middleware compresses again).
func rewriteResponse(resp *http.Response, rw *Rewrite, limit int64) error {
	if rw.Key == "" {
		return errors.New("proxy: rewrite without a key")
	}
	key, repl := []byte(rw.Key), []byte(rw.Replacement)
	for k, vs := range resp.Header {
		for i, v := range vs {
			if strings.Contains(v, rw.Key) {
				vs[i] = strings.ReplaceAll(v, rw.Key, rw.Replacement)
			}
		}
		resp.Header[k] = vs
	}
	if resp.Request != nil && resp.Request.Method == http.MethodHead ||
		resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified {
		return nil
	}
	if passThroughType(resp.Header.Get("Content-Type")) {
		return nil
	}
	var src io.Reader = resp.Body
	switch ce := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding"))); ce {
	case "", "identity":
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			if errors.Is(err, io.EOF) { // empty body
				src = bytes.NewReader(nil)
				break
			}
			return fmt.Errorf("%w: bad gzip: %v", errEncoding, err)
		}
		defer zr.Close()
		src = zr
	default:
		return fmt.Errorf("%w: %q", errEncoding, ce)
	}
	body, err := io.ReadAll(io.LimitReader(src, limit+1))
	_ = resp.Body.Close()
	if err != nil {
		return err
	}
	if int64(len(body)) > limit {
		return ErrTooLarge
	}
	if rw.HideConfigKey {
		body = hideConfigKey(body)
	}
	body = bytes.ReplaceAll(body, key, repl)
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Content-Md5")
	resp.Header.Del("Etag")
	resp.TransferEncoding = nil
	return nil
}

// hideConfigKey sets "api_key" of a JSON object to HiddenKey; other bodies
// are returned unchanged.
func hideConfigKey(body []byte) []byte {
	var m map[string]json.RawMessage
	if json.Unmarshal(body, &m) != nil {
		return body
	}
	if _, ok := m["api_key"]; !ok {
		return body
	}
	m["api_key"] = json.RawMessage(strconv.Quote(HiddenKey))
	out, err := json.Marshal(m)
	if err != nil {
		return body
	}
	return out
}

func (p *Proxy) errorHandler(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrTooLarge):
		p.log.Warn("jackett response too large to rewrite", "path", r.URL.Path)
		WriteError(w, http.StatusBadGateway, "response_too_large", "Ответ Jackett слишком большой")
	case errors.Is(err, errEncoding), errors.Is(err, errUpgrade):
		p.log.Warn("jackett response refused", "path", r.URL.Path, "error", err)
		WriteError(w, http.StatusBadGateway, "jackett_bad_response", "Jackett вернул ответ, который нельзя обработать")
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
