package proxy_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
	"github.com/bropines/jackett-ui/server/internal/proxy"
)

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func setup(t *testing.T, fakePW, ourPW string) (*jackettfake.Fake, *jackett.Client, *proxy.Proxy) {
	t.Helper()
	f := jackettfake.New(fakePW)
	t.Cleanup(f.Close)
	u, _ := url.Parse(f.Server.URL)
	jc := jackett.New(u, ourPW, nil, quiet)
	jc.FailBackoff = 0
	return f, jc, proxy.New(jc, nil, quiet)
}

func do(px *proxy.Proxy, method, target, body string, o proxy.Options, hdr map[string]string) *httptest.ResponseRecorder {
	var rb io.Reader
	if body != "" {
		rb = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, target, rb)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	if o.Path == "" {
		o.Path = r.URL.Path
	}
	w := httptest.NewRecorder()
	px.Serve(w, r, o)
	return w
}

func TestAuthenticatedRequestLogsInAndRetries(t *testing.T) {
	f, _, px := setup(t, "adminpw", "adminpw")
	// No cookie yet → Jackett challenges → login → retry with the cookie.
	w := do(px, "POST", "/api/v2.0/indexers/x/config", `[{"id":"a"}]`, proxy.Options{WithCookie: true}, map[string]string{"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["body"] != `[{"id":"a"}]` {
		t.Fatalf("retried request lost its body: %v", got)
	}
	if f.Logins.Load() != 1 {
		t.Fatalf("logins = %d", f.Logins.Load())
	}
	// Session expires in Jackett (restart) → re-login on the next 401/302.
	f.ExpireSessions()
	w = do(px, "GET", "/api/v2.0/indexers", "", proxy.Options{WithCookie: true}, nil) // no XRW → 302 to /UI/Login
	if w.Code != 200 || f.Logins.Load() != 2 {
		t.Fatalf("status %d logins %d", w.Code, f.Logins.Load())
	}
}

func TestWrongPasswordIs502(t *testing.T) {
	_, _, px := setup(t, "adminpw", "nope")
	w := do(px, "GET", "/api/v2.0/indexers", "", proxy.Options{WithCookie: true}, map[string]string{"X-Requested-With": "XMLHttpRequest"})
	if w.Code != 502 || !strings.Contains(w.Body.String(), `"jackett_login_failed"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}

func TestUnreachableIs502(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1")
	jc := jackett.New(u, "", nil, quiet)
	px := proxy.New(jc, nil, quiet)
	w := do(px, "GET", "/api/v2.0/indexers", "", proxy.Options{WithCookie: true}, nil)
	if w.Code != 502 || !strings.Contains(w.Body.String(), `"jackett_unreachable"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}

func TestHeaderHygiene(t *testing.T) {
	f, jc, px := setup(t, "adminpw", "adminpw")
	if err := jc.Relogin(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	ours, _ := jc.Cookie()
	w := do(px, "GET", "/api/v2.0/indexers?configured=true", "", proxy.Options{WithCookie: true, Proto: "https", Host: "jackett.example.com", For: "198.51.100.7, 127.0.0.1"},
		map[string]string{"Cookie": "jui_session=secret; Jackett=browser-supplied", "X-Forwarded-For": "6.6.6.6", "X-Forwarded-Host": "evil"})
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	s, _ := f.Last("/api/v2.0/indexers")
	if c := s.Header.Get("Cookie"); c != ours {
		t.Fatalf("Jackett saw Cookie %q, want only ours %q", c, ours)
	}
	if s.Query != "configured=true" {
		t.Fatalf("query %q", s.Query)
	}
	if s.Header.Get("X-Forwarded-For") != "198.51.100.7, 127.0.0.1" || s.Header.Get("X-Forwarded-Proto") != "https" ||
		s.Header.Get("X-Forwarded-Host") != "jackett.example.com" || s.Host != "jackett.example.com" {
		t.Fatalf("forwarded headers: %v host %s", s.Header, s.Host)
	}
	if len(w.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("Set-Cookie leaked: %v", w.Header().Values("Set-Cookie"))
	}
	if w.Header().Get("X-Frame-Options") != "" {
		t.Fatal("upstream security header passed through (the front sets its own)")
	}
}

func TestAPIKeyRouteNeverGetsOurCookie(t *testing.T) {
	f, jc, px := setup(t, "adminpw", "adminpw")
	if err := jc.Relogin(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"/api/v2.0/indexers/all/results?apikey=" + jackettfake.APIKey + "&Query=x",
		"/api/v2.0/indexers/rutor/results/torznab/api?apikey=" + jackettfake.APIKey + "&t=caps",
		"/dl/rutor/?jackett_apikey=" + jackettfake.APIKey + "&path=abc",
	} {
		w := do(px, "GET", target, "", proxy.Options{WithCookie: false}, map[string]string{"Cookie": "jui_session=abc"})
		if w.Code != 200 {
			t.Fatalf("%s: status %d", target, w.Code)
		}
		u, _ := url.Parse(target)
		s, _ := f.Last(u.Path)
		if s.Header.Get("Cookie") != "" {
			t.Fatalf("%s: Jackett saw a cookie: %q", target, s.Header.Get("Cookie"))
		}
		if len(w.Header().Values("Set-Cookie")) != 0 {
			t.Fatal("Set-Cookie leaked")
		}
	}
	// A bad key is Jackett's 401, passed through, no re-login.
	n := f.Logins.Load()
	w := do(px, "GET", "/api/v2.0/indexers/all/results?apikey=wrong", "", proxy.Options{}, nil)
	if w.Code != 401 || f.Logins.Load() != n {
		t.Fatalf("status %d logins %d→%d", w.Code, n, f.Logins.Load())
	}
}

func TestConcurrentChallengesCoalesce(t *testing.T) {
	f, _, px := setup(t, "adminpw", "adminpw")
	f.LoginDelay = 50 * time.Millisecond
	var wg sync.WaitGroup
	codes := make(chan int, 15)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- do(px, "GET", "/api/v2.0/indexers", "", proxy.Options{WithCookie: true}, map[string]string{"X-Requested-With": "XMLHttpRequest"}).Code
		}()
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != 200 {
			t.Fatalf("status %d", c)
		}
	}
	if n := f.Logins.Load(); n != 1 {
		t.Fatalf("logins = %d, want 1 (coalesced)", n)
	}
}

func TestBodyLimitAndTimeout(t *testing.T) {
	_, _, px := setup(t, "", "")
	px.MaxBody = 10
	w := do(px, "POST", "/api/v2.0/x", strings.Repeat("a", 11), proxy.Options{WithCookie: true}, nil)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d", w.Code)
	}

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	u, _ := url.Parse(slow.URL)
	px2 := proxy.New(jackett.New(u, "", nil, quiet), nil, quiet)
	px2.Timeout = 50 * time.Millisecond
	px2.SearchTimeout = 5 * time.Second
	start := time.Now()
	w = do(px2, "GET", "/api/v2.0/indexers", "", proxy.Options{}, nil)
	if w.Code != http.StatusGatewayTimeout || time.Since(start) > time.Second {
		t.Fatalf("status %d after %v", w.Code, time.Since(start))
	}
	if !proxy.IsSearchPath("/api/v2.0/indexers/all/results") || proxy.IsSearchPath("/api/v2.0/indexers") {
		t.Fatal("IsSearchPath")
	}
}

func TestJackettBasePath(t *testing.T) {
	var seen string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = r.URL.Path }))
	defer up.Close()
	u, _ := url.Parse(up.URL + "/jackett")
	px := proxy.New(jackett.New(u, "", nil, quiet), nil, quiet)
	do(px, "GET", "/api/v2.0/indexers", "", proxy.Options{}, nil)
	if seen != "/jackett/api/v2.0/indexers" {
		t.Fatalf("upstream path %q", seen)
	}
}
