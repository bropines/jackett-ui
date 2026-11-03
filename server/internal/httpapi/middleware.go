package httpapi

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/bropines/jackett-ui/server/internal/netutil"
	"github.com/bropines/jackett-ui/server/internal/proxy"
)

// ---- JSON helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	proxy.WriteError(w, status, code, msg)
}

// apiError is an error with an HTTP mapping.
type apiError struct {
	Status  int
	Code    string
	Message string
	Field   string
}

func (e *apiError) Error() string { return e.Code }

func writeAPIError(w http.ResponseWriter, err error) {
	var ae *apiError
	if !errors.As(err, &ae) {
		slog.Error("internal error", "error", err)
		writeErr(w, http.StatusInternalServerError, "internal", "Внутренняя ошибка сервера")
		return
	}
	body := map[string]string{"error": ae.Code, "message": ae.Message}
	if ae.Field != "" {
		body["field"] = ae.Field
	}
	writeJSON(w, ae.Status, body)
}

const maxJSONBody = 64 << 10

// decodeJSON reads a JSON body (unknown fields rejected).
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return &apiError{Status: http.StatusRequestEntityTooLarge, Code: "body_too_large", Message: "Слишком большой запрос"}
		}
		return &apiError{Status: http.StatusBadRequest, Code: "bad_request", Message: "Некорректный JSON: " + err.Error()}
	}
	if dec.More() {
		return &apiError{Status: http.StatusBadRequest, Code: "bad_request", Message: "Некорректный JSON: лишние данные"}
	}
	return nil
}

// ---- CSRF ----

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// csrfOK: non-GET requests must carry X-Requested-With: XMLHttpRequest or a
// JSON content type (neither can be sent cross-site without a CORS
// preflight), and a present Origin must equal the effective origin.
func csrfOK(r *http.Request, rv netutil.Resolver) bool {
	if safeMethod(r.Method) {
		return true
	}
	xrw := strings.EqualFold(r.Header.Get("X-Requested-With"), "XMLHttpRequest")
	isJSON := false
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err == nil && mt == "application/json" {
		isJSON = true
	}
	if !xrw && !isJSON {
		return false
	}
	if o := r.Header.Get("Origin"); o != "" {
		// Compare hosts, not schemes: behind a TLS proxy that is not in
		// TRUSTED_PROXIES the effective scheme is http while the browser's
		// Origin is https. A cross-site page has a different host either way.
		u, err := url.Parse(o)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return false
		}
		if !strings.EqualFold(u.Host, rv.Host(r)) && !strings.EqualFold(u.Host, r.Host) {
			return false
		}
	}
	return true
}

// ---- security headers ----

const cspBase = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

// csp returns the policy; formAction are extra form-action origins (the
// login providers' authorization servers).
func csp(formAction string) string {
	if formAction == "" {
		return cspBase
	}
	return cspBase + " " + formAction
}

func setSecurityHeaders(h http.Header, formAction string) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", csp(formAction))
}

// ---- gzip ----

const gzipMinSize = 1024

var gzipPool = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, 5)
	return w
}}

func compressible(ct string) bool {
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return false
	}
	switch {
	case strings.HasPrefix(mt, "text/"):
		return true
	case mt == "application/json", mt == "application/javascript", mt == "application/xml",
		mt == "application/rss+xml", mt == "application/atom+xml", mt == "image/svg+xml",
		mt == "application/manifest+json", strings.HasSuffix(mt, "+json"), strings.HasSuffix(mt, "+xml"):
		return true
	}
	return false
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(enc), "gzip") || strings.TrimSpace(enc) == "*" {
			if strings.Contains(strings.ReplaceAll(params, " ", ""), "q=0") && !strings.Contains(params, "q=0.") {
				return false
			}
			return true
		}
	}
	return false
}

// gzipWriter buffers up to gzipMinSize bytes before deciding.
type gzipWriter struct {
	http.ResponseWriter
	status  int
	wrote   bool // headers sent downstream
	decided bool
	gz      *gzip.Writer
	buf     []byte
	head    bool
}

func (g *gzipWriter) WriteHeader(code int) {
	if g.status != 0 {
		return
	}
	g.status = code
	if code < 200 || code == http.StatusNoContent || code == http.StatusNotModified || code == http.StatusPartialContent || g.head ||
		!g.eligible() {
		g.decide(false)
		return
	}
	if cl := g.Header().Get("Content-Length"); cl != "" {
		// Known size: decide now.
		var n int64
		for _, c := range cl {
			if c < '0' || c > '9' {
				n = -1
				break
			}
			n = n*10 + int64(c-'0')
		}
		g.decide(n >= gzipMinSize)
	}
}

func (g *gzipWriter) eligible() bool {
	h := g.Header()
	if h.Get("Content-Encoding") != "" || h.Get("Content-Range") != "" {
		return false
	}
	return compressible(h.Get("Content-Type"))
}

func (g *gzipWriter) decide(compress bool) {
	if g.decided {
		return
	}
	g.decided = true
	h := g.Header()
	if g.eligible() {
		h.Add("Vary", "Accept-Encoding")
	}
	if compress {
		h.Del("Content-Length")
		h.Del("Accept-Ranges")
		h.Set("Content-Encoding", "gzip")
		if et := h.Get("ETag"); et != "" && !strings.HasPrefix(et, "W/") {
			h.Set("ETag", "W/"+et)
		}
		g.gz = gzipPool.Get().(*gzip.Writer)
		g.gz.Reset(g.ResponseWriter)
	}
	g.wrote = true
	g.ResponseWriter.WriteHeader(g.status)
	if len(g.buf) > 0 {
		b := g.buf
		g.buf = nil
		_, _ = g.write(b)
	}
}

func (g *gzipWriter) write(p []byte) (int, error) {
	if g.gz != nil {
		return g.gz.Write(p)
	}
	return g.ResponseWriter.Write(p)
}

func (g *gzipWriter) Write(p []byte) (int, error) {
	if g.status == 0 {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(p))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.decided {
		return g.write(p)
	}
	g.buf = append(g.buf, p...)
	if len(g.buf) >= gzipMinSize {
		g.decide(true)
	}
	return len(p), nil
}

// Flush decides and flushes. An undecided response here is an eligible one
// of unknown length that is being streamed (ReverseProxy flushes chunked
// upstream responses early): compress it, the size is unknown.
func (g *gzipWriter) Flush() {
	if g.status == 0 {
		return
	}
	if !g.decided {
		g.decide(true)
	}
	if g.gz != nil {
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipWriter) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := g.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

func (g *gzipWriter) close() {
	if g.status == 0 {
		return
	}
	if !g.decided {
		g.decide(false)
	}
	if g.gz != nil {
		_ = g.gz.Close()
		g.gz.Reset(io.Discard)
		gzipPool.Put(g.gz)
		g.gz = nil
	}
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) {
			next.ServeHTTP(w, r)
			return
		}
		g := &gzipWriter{ResponseWriter: w, head: r.Method == http.MethodHead}
		defer g.close()
		next.ServeHTTP(g, r)
	})
}

// ---- debug request log ----

type statusRecorder struct {
	http.ResponseWriter
	status int
	n      int64
}

func (s *statusRecorder) WriteHeader(c int) {
	if s.status == 0 {
		s.status = c
	}
	s.ResponseWriter.WriteHeader(c)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(p)
	s.n += int64(n)
	return n, err
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func requestLog(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !log.Enabled(r.Context(), slog.LevelDebug) {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "bytes", rec.n,
			"duration", time.Since(start).Round(time.Millisecond), "peer", netutil.PeerIP(r).String())
	})
}
