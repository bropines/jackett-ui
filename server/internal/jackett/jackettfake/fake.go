// Package jackettfake is an in-process fake Jackett for tests: the
// /UI/Dashboard cookie login, login challenges (401 with X-Requested-With,
// else 302 to /UI/Login), API-key routes and an echo endpoint.
package jackettfake

import (
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// APIKey is the fake's API key.
const APIKey = "fakeapikey123"

// Version is reported by /api/v2.0/server/config.
const Version = "0.24.3003"

// Seen is what the fake saw on one request.
type Seen struct {
	Method string
	Path   string
	Query  string
	Host   string
	Header http.Header
	Body   string
}

// Fake is the fake Jackett.
type Fake struct {
	Server *httptest.Server

	// LoginDelay delays login responses (to test coalescing).
	LoginDelay time.Duration

	Logins atomic.Int64

	mu       sync.Mutex
	password string
	valid    map[string]bool
	seen     []Seen
}

// New starts a fake with admin password pw ("" = none).
func New(pw string) *Fake {
	f := &Fake{password: pw, valid: map[string]bool{}}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

// Close stops the server.
func (f *Fake) Close() { f.Server.Close() }

// SetPassword changes the admin password.
func (f *Fake) SetPassword(pw string) {
	f.mu.Lock()
	f.password = pw
	f.mu.Unlock()
}

// ExpireSessions invalidates all login cookies (like a Jackett restart).
func (f *Fake) ExpireSessions() {
	f.mu.Lock()
	f.valid = map[string]bool{}
	f.mu.Unlock()
}

// Seen returns all recorded requests.
func (f *Fake) Seen() []Seen {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Seen(nil), f.seen...)
}

// Last returns the last recorded request for path.
func (f *Fake) Last(path string) (Seen, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.seen) - 1; i >= 0; i-- {
		if f.seen[i].Path == path {
			return f.seen[i], true
		}
	}
	return Seen{}, false
}

func (f *Fake) authed(r *http.Request) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.password == "" {
		return true
	}
	c, err := r.Cookie("Jackett")
	return err == nil && f.valid[c.Value]
}

func (f *Fake) challenge(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Requested-With") == "XMLHttpRequest" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	http.Redirect(w, r, "/UI/Login?ReturnUrl=%2FUI%2FDashboard", http.StatusFound)
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.seen = append(f.seen, Seen{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Host: r.Host, Header: r.Header.Clone(), Body: string(body)})
	f.mu.Unlock()

	p := r.URL.Path
	switch {
	case p == "/UI/Dashboard" && r.Method == http.MethodPost:
		f.Logins.Add(1)
		if f.LoginDelay > 0 {
			time.Sleep(f.LoginDelay)
		}
		form := parseForm(string(body))
		f.mu.Lock()
		ok := f.password != "" && form["password"] == f.password
		var tok string
		if ok {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			tok = hex.EncodeToString(b)
			f.valid[tok] = true
		}
		f.mu.Unlock()
		if ok {
			http.SetCookie(w, &http.Cookie{Name: "Jackett", Value: tok, Path: "/", HttpOnly: true})
		}
		http.Redirect(w, r, "Dashboard", http.StatusFound)
		return
	case isAPIKeyPath(p):
		if r.URL.Query().Get("apikey") != APIKey && r.URL.Query().Get("jackett_apikey") != APIKey {
			send(w, r, http.StatusUnauthorized, "application/json", []byte(`{"error":"bad apikey"}`))
			return
		}
		// Like Jackett, every link carries the API key, and so does a header.
		w.Header().Set("Set-Cookie", "evil=1; Path=/")
		w.Header().Set("X-Jackett-Link", "http://127.0.0.1:9117/dl/x/?jackett_apikey="+APIKey)
		switch {
		case strings.HasPrefix(p, "/dl/"):
			send(w, r, http.StatusOK, "application/x-bittorrent", []byte(TorrentBody))
		case strings.Contains(p, "/results/torznab"):
			send(w, r, http.StatusOK, "application/rss+xml; charset=utf-8", []byte(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item><title>x</title>`+
				`<link>http://127.0.0.1:9117/dl/rutor/?jackett_apikey=`+APIKey+`&amp;path=abc&amp;file=x</link>`+
				`<torznab:attr name="magneturl" value="http://127.0.0.1:9117/dl/rutor/?jackett_apikey=`+APIKey+`"/></item></channel></rss>`))
		default:
			b, _ := json.Marshal(map[string]any{"ok": true, "path": p, "query": r.URL.RawQuery,
				"Results": []map[string]any{{"Link": "http://127.0.0.1:9117/dl/rutor/?jackett_apikey=" + APIKey + "&path=abc", "Pad": strings.Repeat("r", 2048)}}})
			send(w, r, http.StatusOK, "application/json", b)
		}
		return
	}
	if !f.authed(r) {
		f.challenge(w, r)
		return
	}
	switch {
	case p == "/api/v2.0/server/config":
		b, _ := json.Marshal(map[string]any{"app_version": Version, "api_key": APIKey, "port": 9117, "blackholedir": "/x/" + APIKey})
		send(w, r, http.StatusOK, "application/json", b)
	case p == "/api/v2.0/big":
		send(w, r, http.StatusOK, "application/json", []byte(`{"data":"`+strings.Repeat("x", 4096)+`"}`))
	case p == "/api/v2.0/html":
		send(w, r, http.StatusOK, "text/html", []byte(`<a href="/dl/a/?jackett_apikey=`+APIKey+`">x</a>`))
	default:
		w.Header().Set("Set-Cookie", "Jackett=leaked; Path=/")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("X-Jackett-Link", "http://127.0.0.1:9117/dl/x/?jackett_apikey="+APIKey)
		b, _ := json.Marshal(map[string]any{"path": p, "method": r.Method, "body": string(body), "query": r.URL.RawQuery,
			"link": "http://127.0.0.1:9117/dl/x/?jackett_apikey=" + APIKey})
		send(w, r, http.StatusOK, "application/json", b)
	}
}

// TorrentBody is what /dl/* returns (a fake torrent without the key).
const TorrentBody = "d8:announce14:http://tracker4:infod4:name1:xee"

// send writes body, gzip-compressed when the client accepts it (like
// Jackett's response compression).
func send(w http.ResponseWriter, r *http.Request, status int, ct string, body []byte) {
	w.Header().Set("Content-Type", ct)
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(body)
		_ = zw.Close()
		body = buf.Bytes()
		w.Header().Set("Content-Encoding", "gzip")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func isAPIKeyPath(p string) bool {
	return strings.HasPrefix(p, "/dl/") || strings.HasPrefix(p, "/bh/") ||
		(strings.HasPrefix(p, "/api/v2.0/indexers/") && strings.Contains(p, "/results"))
}

func parseForm(s string) map[string]string {
	out := map[string]string{}
	q, _ := url.ParseQuery(s)
	for k := range q {
		out[k] = q.Get(k)
	}
	return out
}
