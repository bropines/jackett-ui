// Package jackettfake is an in-process fake Jackett for tests: the
// /UI/Dashboard cookie login, login challenges (401 with X-Requested-With,
// else 302 to /UI/Login), API-key routes and an echo endpoint.
package jackettfake

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"bad apikey"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "evil=1; Path=/")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "path": p})
		return
	}
	if !f.authed(r) {
		f.challenge(w, r)
		return
	}
	switch {
	case p == "/api/v2.0/server/config":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"app_version": Version, "api_key": APIKey})
	case p == "/api/v2.0/big":
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":"`+strings.Repeat("x", 4096)+`"}`)
	default:
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "Jackett=leaked; Path=/")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		_ = json.NewEncoder(w).Encode(map[string]any{"path": p, "method": r.Method, "body": string(body)})
	}
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
