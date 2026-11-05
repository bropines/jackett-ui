package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/proxy"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/torrent"
)

// Limits of GET /_ui/api/torrent/files.
const (
	torrentFetchTimeout = 20 * time.Second
	torrentMaxBody      = 10 << 20
	torrentMaxFiles     = 5000
)

// torrentFilesResponse: either {"magnet": true} or the parsed torrent.
type torrentFilesResponse struct {
	Magnet bool `json:"magnet,omitempty"`
	*torrent.Info
}

// torrentLinkPath checks the link the UI got from a search result and
// returns the Jackett path and raw query to fetch. Only this panel's own
// download path is allowed (/dl/...): a relative path, or an absolute URL
// whose host is our effective host (or the request's Host). Anything else
// would let a user make the server fetch arbitrary URLs.
func torrentLinkPath(raw string, r *http.Request, re *reqEnv) (p, lp, query string, ok bool) {
	if raw == "" || len(raw) > 8<<10 {
		return "", "", "", false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil {
		return "", "", "", false
	}
	if u.Scheme != "" || u.Host != "" {
		if u.Scheme != "http" && u.Scheme != "https" {
			return "", "", "", false
		}
		if !strings.EqualFold(u.Host, re.rv.Host(r)) && !strings.EqualFold(u.Host, r.Host) {
			return "", "", "", false
		}
	}
	if !strings.HasPrefix(u.Path, "/") || badPath(u.Path) {
		return "", "", "", false
	}
	p = cleanPath(u.Path)
	lp = strings.ToLower(p)
	if !strings.HasPrefix(lp, "/dl/") {
		return "", "", "", false
	}
	return p, lp, u.RawQuery, true
}

// handleTorrentFiles: GET /_ui/api/torrent/files?link=<url> — downloads the
// .torrent through the Jackett proxy (API key injected exactly like a
// session request to /dl) and lists its files.
func (s *Server) handleTorrentFiles(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	if config.RoleRank(pr.role) < config.RoleRank(store.RoleViewer) {
		writeForbidden(w)
		return
	}
	p, lp, rawQuery, ok := torrentLinkPath(r.URL.Query().Get("link"), r, re)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_link", "Ссылка не ведёт на скачивание через эту панель (/dl/…)")
		return
	}

	realKey, err := s.jc.APIKey(r.Context())
	if err != nil {
		if errors.Is(err, jackett.ErrLoginFailed) {
			writeErr(w, http.StatusBadGateway, "jackett_login_failed", "Jackett не принял пароль администратора (JACKETT_PASSWORD)")
		} else {
			writeErr(w, http.StatusBadGateway, "jackett_unreachable", "Jackett недоступен")
		}
		return
	}
	query := upstreamQuery(rawQuery, lp, realKey)

	// A fresh context (cancelled with the client's): a request context from
	// net/http would make ReverseProxy panic(ErrAbortHandler) when the copy
	// into our capped buffer stops, which would kill the client's response.
	ctx, cancel := context.WithTimeout(context.Background(), torrentFetchTimeout)
	defer cancel()
	stop := context.AfterFunc(r.Context(), cancel)
	defer stop()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p, nil)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_link", "Некорректная ссылка")
		return
	}
	req.RemoteAddr = r.RemoteAddr
	req.Header.Set("Accept", "application/x-bittorrent, */*")
	if ua := r.Header.Get("User-Agent"); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	cw := newCaptureWriter(torrentMaxBody)
	s.proxy.Serve(cw, req, proxy.Options{
		Path: p, Proto: re.rv.Scheme(r), Host: re.rv.Host(r), For: re.rv.ForwardedFor(r),
		RawQuery: &query,
		// Like any /dl request: never the Jackett cookie. The response is
		// never relayed, so it isn't rewritten (keeps the torrent's bytes).
		WithCookie: false,
	})

	if r.Context().Err() != nil {
		return // the client went away
	}
	if cw.overflow {
		writeErr(w, http.StatusBadGateway, "fetch_failed", "Файл .torrent больше 10 МБ")
		return
	}
	status := cw.status
	if status >= 300 && status < 400 {
		if loc := strings.TrimSpace(cw.header.Get("Location")); len(loc) >= 7 && strings.EqualFold(loc[:7], "magnet:") {
			writeJSON(w, http.StatusOK, torrentFilesResponse{Magnet: true})
			return
		}
		writeErr(w, http.StatusBadGateway, "fetch_failed", "Jackett перенаправил на другой адрес вместо .torrent-файла")
		return
	}
	if status != http.StatusOK {
		writeErr(w, http.StatusBadGateway, "fetch_failed", fetchFailedMessage(status, cw.header, cw.buf.Bytes()))
		return
	}
	body := cw.buf.Bytes()
	if ce := strings.ToLower(strings.TrimSpace(cw.header.Get("Content-Encoding"))); ce == "gzip" || ce == "x-gzip" {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err == nil {
			body, err = io.ReadAll(io.LimitReader(zr, torrentMaxBody+1))
		}
		if err != nil {
			writeErr(w, http.StatusBadGateway, "fetch_failed", "Jackett прислал повреждённый ответ")
			return
		}
		if len(body) > torrentMaxBody {
			writeErr(w, http.StatusBadGateway, "fetch_failed", "Файл .torrent больше 10 МБ")
			return
		}
	}
	info, err := torrent.Parse(body, torrentMaxFiles)
	if err != nil {
		s.log.Debug("torrent files: not a torrent", "path", p, "error", err)
		writeErr(w, http.StatusUnprocessableEntity, "not_a_torrent", "Трекер вернул не .torrent-файл")
		return
	}
	writeJSON(w, http.StatusOK, torrentFilesResponse{Info: info})
}

// fetchFailedMessage explains a failed download in Russian; the proxy's own
// errors (timeout, Jackett unreachable) come as {"error","message"}.
func fetchFailedMessage(status int, h http.Header, body []byte) string {
	if strings.HasPrefix(h.Get("Content-Type"), "application/json") {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &e) == nil {
			switch e.Error {
			case "jackett_timeout":
				return "Jackett не отдал .torrent за 20 секунд"
			case "jackett_unreachable", "jackett_login_failed", "jackett_bad_response":
				return e.Message
			}
		}
	}
	if status == 0 {
		return "Не удалось скачать .torrent через Jackett"
	}
	return fmt.Sprintf("Не удалось скачать .torrent через Jackett (HTTP %d)", status)
}

// captureWriter is an in-memory ResponseWriter with a body cap: past the cap
// Write fails, which stops the proxy's copy.
type captureWriter struct {
	header   http.Header
	status   int
	buf      bytes.Buffer
	limit    int
	overflow bool
}

func newCaptureWriter(limit int) *captureWriter {
	return &captureWriter{header: http.Header{}, limit: limit}
}

func (c *captureWriter) Header() http.Header { return c.header }

func (c *captureWriter) WriteHeader(code int) {
	if c.status == 0 {
		c.status = code
	}
}

var errCaptureFull = errors.New("capture: body limit exceeded")

func (c *captureWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	if c.buf.Len()+len(p) > c.limit {
		c.overflow = true
		return 0, errCaptureFull
	}
	return c.buf.Write(p)
}
