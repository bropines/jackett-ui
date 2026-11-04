package httpapi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bropines/jackett-ui/server/internal/jackett/jackettfake"
	"github.com/bropines/jackett-ui/server/internal/session"
)

// world: an admin harness plus viewer/editor/admin sessions and tokens.
type world struct {
	h        *harness
	sessions map[string]*harness // role → logged-in client
	tokens   map[string]string   // role → token
	ids      map[string]string   // role → user id
}

func newWorld(t *testing.T, o harnessOpt) *world {
	t.Helper()
	h := newHarness(t, o)
	h.setup()
	w := &world{h: h, sessions: map[string]*harness{"admin": h}, tokens: map[string]string{}, ids: map[string]string{"admin": h.userByName("admin").ID}}
	for _, role := range []string{"viewer", "editor"} {
		w.ids[role] = h.createUser(role+"1", role, role+"-password")
		w.sessions[role] = h.as(role+"1", role+"-password")
	}
	for role, c := range w.sessions {
		w.tokens[role] = c.newToken(role + " token").Token
	}
	return w
}

func withKey(target, tok string) string {
	if strings.Contains(target, "?") {
		return target + "&apikey=" + tok
	}
	return target + "?apikey=" + tok
}

func TestRolePathMatrix(t *testing.T) {
	w := newWorld(t, harnessOpt{})
	cases := []struct {
		method, target, need string
	}{
		{"GET", "/api/v2.0/indexers", "viewer"},
		{"GET", "/api/v2.0/indexers/?configured=true", "viewer"},
		{"GET", "/api/v2.0/indexers/all/results?Query=x&Tracker[]=rutor", "viewer"},
		{"GET", "/api/v2.0/indexers/rutor/results/torznab/api?t=caps", "viewer"},
		{"GET", "/api/v2.0/indexers/rutor/results/torznab/", "viewer"},
		{"GET", "/api/v2.0/indexers/rutor/results/potato/", "viewer"},
		{"HEAD", "/api/v2.0/indexers/all/results", "viewer"},
		{"GET", "/dl/rutor/?path=x&file=y", "viewer"},
		{"GET", "/bh/rutor/?path=x", "viewer"},
		{"GET", "/api/v2.0/indexers/rutor/config", "editor"},
		{"POST", "/api/v2.0/indexers/rutor/config", "editor"},
		{"DELETE", "/api/v2.0/indexers/rutor", "editor"},
		{"POST", "/api/v2.0/indexers/rutor/test", "editor"},
		{"GET", "/api/v2.0/indexers/cache", "editor"},
		{"GET", "/api/v2.0/server/logs", "editor"},
		{"GET", "/api/v2.0/server/config", "admin"},
		{"POST", "/api/v2.0/server/config", "admin"},
		{"POST", "/api/v2.0/server/update", "admin"},
		{"POST", "/api/v2.0/server/adminpassword", "admin"},
		{"GET", "/api/v2.0/server/whatever", "admin"},
		{"GET", "/api/v2.0/somethingnew", "admin"},
		{"GET", "/api/v2.0/indexers/rutor/results/other", "admin"},
		{"POST", "/api/v2.0/indexers/all/results", "admin"},
		{"DELETE", "/api/v2.0/indexers/cache", "admin"},
		{"PUT", "/api/v2.0/indexers/rutor/config", "admin"},
		{"GET", "/api/v2.0/indexers/rutor/config/extra", "admin"},
		{"GET", "/API/V2.0//Server/Config", "admin"},
		{"GET", "/api/v2.0/indexers/x/../../server/config", "admin"},
		{"GET", "/api/v2.0/indexers/x/results/../../../server/config", "admin"},
		{"GET", "/api/v2.0/indexers//results", "admin"},
		{"POST", "/dl/rutor/", "admin"},
		{"GET", "/dl", "admin"},
		{"GET", "/api", "admin"},
		{"GET", "/UI/other", "admin"},
	}
	rank := map[string]int{"viewer": 1, "editor": 2, "admin": 3}
	for _, c := range cases {
		for _, who := range []string{"anonymous", "viewer", "editor", "admin", "viewer token", "editor token", "admin token"} {
			t.Run(c.method+" "+c.target+" as "+who, func(t *testing.T) {
				role, isToken := strings.CutSuffix(who, " token")
				before := len(w.h.jackett.Seen())
				var res *httptest.ResponseRecorder
				switch {
				case who == "anonymous":
					res = w.h.clone().do(c.method, c.target, nil, xhr)
				case isToken:
					res = w.h.clone().do(c.method, withKey(c.target, w.tokens[role]), nil)
				default:
					res = w.sessions[role].do(c.method, c.target, nil, xhr)
				}
				reached := len(w.h.jackett.Seen()) > before
				switch {
				case who == "anonymous":
					if res.Code != 401 || reached {
						t.Fatalf("anonymous: %d reached=%v", res.Code, reached)
					}
				case rank[role] >= rank[c.need]:
					if !reached || errorCode(res) == "forbidden" || errorCode(res) == "unauthorized" || errorCode(res) == "invalid_token" {
						t.Fatalf("allowed but %d reached=%v %s", res.Code, reached, res.Body)
					}
				default:
					if res.Code != 403 || errorCode(res) != "forbidden" || reached {
						t.Fatalf("denied but %d reached=%v %s", res.Code, reached, res.Body)
					}
				}
			})
		}
	}
	// Tokens never open /_ui/api.
	for _, role := range []string{"viewer", "admin"} {
		c := w.h.clone()
		for _, target := range []string{withKey("/_ui/api/me", w.tokens[role]), withKey("/_ui/api/settings", w.tokens[role])} {
			if res := c.do("GET", target, nil, hdr("X-Api-Key", w.tokens[role])); res.Code != 401 {
				t.Fatalf("%s token on %s: %d", role, target, res.Code)
			}
		}
	}
	// /_ui/api by role.
	uiCases := []struct {
		method, target, need string
	}{
		{"GET", "/_ui/api/me", "viewer"},
		{"GET", "/_ui/api/me/tokens", "viewer"},
		{"GET", "/_ui/api/users", "admin"},
		{"POST", "/_ui/api/users", "admin"},
		{"GET", "/_ui/api/users/" + w.ids["viewer"] + "/tokens", "admin"},
		{"POST", "/_ui/api/users/" + w.ids["viewer"] + "/logout", "admin"},
		{"GET", "/_ui/api/invites", "admin"},
		{"POST", "/_ui/api/invites", "admin"},
		{"DELETE", "/_ui/api/invites/i_nope", "admin"},
		{"DELETE", "/_ui/api/tokens/t_nope", "admin"},
		{"GET", "/_ui/api/settings", "admin"},
		{"PUT", "/_ui/api/settings", "admin"},
		{"POST", "/_ui/api/settings/providers/oidc/test", "admin"},
	}
	for _, c := range uiCases {
		for _, role := range []string{"viewer", "editor"} {
			if rank[role] >= rank[c.need] {
				continue
			}
			res := w.sessions[role].do(c.method, c.target, "{}", hdr("Content-Type", "application/json"))
			if res.Code != 403 || errorCode(res) != "forbidden" {
				t.Errorf("%s %s as %s: %d %s", c.method, c.target, role, res.Code, res.Body)
			}
		}
	}
	if res := w.sessions["viewer"].do("GET", "/_ui/api/me", nil); res.Code != 200 {
		t.Fatalf("viewer /me: %d", res.Code)
	}
}

// body returns the (gunzipped) response body.
func body(t *testing.T, res *httptest.ResponseRecorder) string {
	t.Helper()
	b := res.Body.Bytes()
	if res.Header().Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		b, _ = io.ReadAll(zr)
	}
	return string(b)
}

func assertNoKey(t *testing.T, what string, res *httptest.ResponseRecorder) string {
	t.Helper()
	b := body(t, res)
	if strings.Contains(b, key) || strings.Contains(res.Body.String(), key) {
		t.Fatalf("%s: Jackett's key in the body: %s", what, b)
	}
	for k, vs := range res.Header() {
		for _, v := range vs {
			if strings.Contains(v, key) {
				t.Fatalf("%s: Jackett's key in header %s: %s", what, k, v)
			}
		}
	}
	return b
}

func TestJackettKeyNeverLeaks(t *testing.T) {
	w := newWorld(t, harnessOpt{})
	targets := []struct {
		method, target string
	}{
		{"GET", "/api/v2.0/indexers"},
		{"GET", "/api/v2.0/indexers/all/results?Query=x"},
		{"GET", "/api/v2.0/indexers/rutor/results/torznab/api?t=search&q=x"},
		{"GET", "/api/v2.0/indexers/rutor/results/potato/?search=x"},
		{"GET", "/dl/rutor/?path=x"},
		{"GET", "/bh/rutor/?path=x"},
		{"GET", "/api/v2.0/indexers/rutor/config"},
		{"GET", "/api/v2.0/server/logs"},
		{"GET", "/api/v2.0/server/config"},
		{"GET", "/api/v2.0/html"},
		{"GET", "/api/v2.0/big"},
		{"POST", "/api/v2.0/server/config"},
		{"GET", "/UI/other"},
		{"GET", "/api/v2.0/indexers/all/results?Query=x&apikey=" + key}, // the key itself as input
	}
	encodings := []string{"", "gzip"}
	for _, tg := range targets {
		for _, enc := range encodings {
			for _, who := range []string{"viewer", "editor", "admin", "viewer token", "editor token", "admin token", "anonymous"} {
				role, isToken := strings.CutSuffix(who, " token")
				var res *httptest.ResponseRecorder
				opts := []reqOpt{xhr}
				if enc != "" {
					opts = append(opts, hdr("Accept-Encoding", enc))
				}
				switch {
				case who == "anonymous":
					res = w.h.clone().do(tg.method, tg.target, "{}", opts...)
				case isToken:
					res = w.h.clone().do(tg.method, withKey(tg.target, w.tokens[role]), "{}", opts...)
				default:
					res = w.sessions[role].do(tg.method, tg.target, "{}", opts...)
				}
				b := assertNoKey(t, who+" "+tg.method+" "+tg.target+" enc="+enc, res)
				if res.Code != 200 {
					continue
				}
				// The key became the caller's own token, or "session".
				if strings.Contains(tg.target, "torznab") || strings.Contains(tg.target, "/results?") {
					want := "jackett_apikey=session"
					if isToken {
						want = "jackett_apikey=" + w.tokens[role]
					}
					if !strings.Contains(b, want) {
						t.Fatalf("%s %s: %q not in %s", who, tg.target, want, b)
					}
					if link := res.Header().Get("X-Jackett-Link"); !strings.Contains(link, want) {
						t.Fatalf("%s %s: header %q", who, tg.target, link)
					}
				}
				if strings.HasPrefix(tg.target, "/dl/") && b != jackettfake.TorrentBody {
					t.Fatalf("torrent changed: %q", b)
				}
			}
		}
	}
	// server/config for an admin: api_key is "(hidden)".
	res := w.h.do("GET", "/api/v2.0/server/config", nil, hdr("Accept-Encoding", "gzip"))
	var cfg map[string]any
	if err := json.Unmarshal([]byte(body(t, res)), &cfg); err != nil || cfg["api_key"] != "(hidden)" || cfg["blackholedir"] != "/x/session" || cfg["app_version"] != jackettfake.Version {
		t.Fatalf("server/config: %v %v", err, cfg)
	}
	// Disabled login (anonymous admin) is scrubbed too.
	d := newHarness(t, harnessOpt{env: map[string]string{"AUTH_DISABLED": "true"}})
	for _, tg := range targets {
		assertNoKey(t, "disabled "+tg.target, d.do(tg.method, tg.target, "{}", xhr, hdr("Accept-Encoding", "gzip")))
	}
	// Torznab XML for a token stays valid XML with the token in the links.
	res = w.h.clone().do("GET", withKey("/api/v2.0/indexers/rutor/results/torznab/api?t=search", w.tokens["viewer"]), nil)
	if b := body(t, res); res.Code != 200 || !strings.HasPrefix(b, "<?xml") || !strings.Contains(b, "jackett_apikey="+w.tokens["viewer"]+"&amp;path=abc") ||
		!strings.Contains(res.Header().Get("Content-Type"), "rss+xml") {
		t.Fatalf("torznab: %d %s", res.Code, b)
	}
}

func TestTokenRequestsUpstream(t *testing.T) {
	w := newWorld(t, harnessOpt{})
	tok := w.tokens["viewer"]
	c := w.h.clone()
	// apikey, jackett_apikey, X-Api-Key are all accepted.
	c.expect(c.do("GET", "/api/v2.0/indexers/all/results?Query=x&apikey="+tok, nil), 200)
	s, _ := w.h.jackett.Last("/api/v2.0/indexers/all/results")
	if s.Query != "Query=x&apikey="+key || s.Header.Get("Cookie") != "" || s.Header.Get("X-Api-Key") != "" {
		t.Fatalf("upstream: %q %v", s.Query, s.Header)
	}
	c.expect(c.do("GET", "/dl/rutor/?jackett_apikey="+tok+"&path=x", nil), 200)
	s, _ = w.h.jackett.Last("/dl/rutor/")
	if s.Query != "jackett_apikey="+key+"&path=x" || s.Header.Get("Cookie") != "" {
		t.Fatalf("dl upstream: %q", s.Query)
	}
	c.expect(c.do("GET", "/api/v2.0/indexers/rutor/results/torznab/api?t=caps", nil, hdr("X-Api-Key", tok)), 200)
	s, _ = w.h.jackett.Last("/api/v2.0/indexers/rutor/results/torznab/api")
	if s.Query != "t=caps&apikey="+key || s.Header.Get("X-Api-Key") != "" {
		t.Fatalf("header token upstream: %q %v", s.Query, s.Header)
	}
	// Encoded / odd-case parameter names are still recognised and replaced.
	c.expect(c.do("GET", "/api/v2.0/indexers/all/results?APIKEY="+tok+"&ap%69key="+tok, nil), 200)
	s, _ = w.h.jackett.Last("/api/v2.0/indexers/all/results")
	if strings.Contains(s.Query, tok) {
		t.Fatalf("token reached Jackett: %q", s.Query)
	}
	// The token never reaches Jackett anywhere.
	for _, seen := range w.h.jackett.Seen() {
		if strings.Contains(seen.Query, "jui_") || strings.Contains(seen.Body, "jui_") || strings.Contains(seen.Header.Get("X-Api-Key"), "jui_") {
			t.Fatalf("token sent upstream: %+v", seen)
		}
	}
	// Session search without a key: the server injects it, no cookie.
	w.sessions["viewer"].expect(w.sessions["viewer"].do("GET", "/api/v2.0/indexers/all/results?Query=y", nil), 200)
	s, _ = w.h.jackett.Last("/api/v2.0/indexers/all/results")
	if s.Query != "Query=y&apikey="+key || s.Header.Get("Cookie") != "" {
		t.Fatalf("session search upstream: %q %v", s.Query, s.Header)
	}
	// apikey=session needs the cookie.
	if res := c.do("GET", "/api/v2.0/indexers/all/results?apikey=session", nil); res.Code != 401 {
		t.Fatalf("session placeholder without cookie: %d", res.Code)
	}
	w.sessions["viewer"].expect(w.sessions["viewer"].do("GET", "/dl/rutor/?jackett_apikey=session&path=x", nil), 200)
	// Conflicting keys are refused.
	if res := c.do("GET", "/api/v2.0/indexers/all/results?apikey="+tok+"&jackett_apikey="+w.tokens["admin"], nil); res.Code != 401 || errorCode(res) != "invalid_token" {
		t.Fatalf("conflict: %d", res.Code)
	}
	if res := c.do("GET", "/api/v2.0/indexers/all/results?apikey="+tok, nil, hdr("X-Api-Key", key)); res.Code != 401 {
		t.Fatalf("token + real key: %d", res.Code)
	}
	// The UI posts server/config back with "(hidden)": Jackett gets the real key.
	w.h.expect(w.h.do("POST", "/api/v2.0/server/config", `{"api_key":"(hidden)","port":9117}`, hdr("Content-Type", "application/json")), 200)
	s, _ = w.h.jackett.Last("/api/v2.0/server/config")
	if s.Method != "POST" || !strings.Contains(s.Body, `"api_key":"`+key+`"`) || strings.Contains(s.Body, "hidden") {
		t.Fatalf("config post upstream: %s", s.Body)
	}
}

func TestTokenLifecycle(t *testing.T) {
	w := newWorld(t, harnessOpt{})
	h := w.h
	viewer := w.sessions["viewer"]
	search := "/api/v2.0/indexers/all/results?Query=x&apikey="

	created := viewer.newToken("qBittorrent")
	if !strings.HasPrefix(created.Token, "jui_") || len(created.Token) != 36 || created.Prefix != created.Token[:8] || created.ExpiresAt != nil {
		t.Fatalf("created: %+v", created)
	}
	// Stored hashed only, shown once.
	raw := string(mustJSON(h.store.Get()))
	if strings.Contains(raw, created.Token) {
		t.Fatal("token stored in plain text")
	}
	me := viewer.do("GET", "/_ui/api/me", nil)
	if strings.Contains(me.Body.String(), created.Token) || !strings.Contains(me.Body.String(), created.Prefix) {
		t.Fatalf("me: %s", me.Body)
	}
	// Use → lastUsedAt / lastUsedIp.
	c := h.clone()
	c.expect(c.do("GET", search+created.Token, nil), 200)
	var mine []tokenView
	mine = decode[[]tokenView](t, viewer.do("GET", "/_ui/api/me/tokens", nil))
	var tv tokenView
	for _, x := range mine {
		if x.ID == created.ID {
			tv = x
		}
	}
	if tv.LastUsedAt == nil || tv.LastUsedIP != "192.0.2.10" {
		t.Fatalf("usage: %+v", tv)
	}
	h.srv.Flush()
	for _, st := range h.store.Get().Tokens {
		if st.ID == created.ID && (st.LastUsedAt == nil || st.LastUsedIP != "192.0.2.10") {
			t.Fatalf("usage not persisted: %+v", st)
		}
	}
	// Another user can't revoke it; the owner can; an admin can revoke any.
	w.sessions["editor"].expect(w.sessions["editor"].do("DELETE", "/_ui/api/me/tokens/"+created.ID, nil, xhr), 404)
	viewer.expect(viewer.do("DELETE", "/_ui/api/me/tokens/"+created.ID, nil, xhr), 204)
	if res := c.do("GET", search+created.Token, nil); res.Code != 401 || errorCode(res) != "invalid_token" {
		t.Fatalf("revoked: %d", res.Code)
	}
	other := viewer.newToken("other")
	toks := decode[[]tokenView](t, h.do("GET", "/_ui/api/users/"+w.ids["viewer"]+"/tokens", nil))
	if len(toks) != 2 {
		t.Fatalf("admin view: %+v", toks)
	}
	h.expect(h.do("DELETE", "/_ui/api/tokens/"+other.ID, nil, xhr), 204)
	c.expect(c.do("GET", search+other.Token, nil), 401)

	// Expiry.
	exp := decode[createdToken](t, viewer.do("POST", "/_ui/api/me/tokens", map[string]any{"name": "short", "expiresInDays": 1}))
	if exp.ExpiresAt == nil {
		t.Fatal("no expiry")
	}
	c.expect(c.do("GET", search+exp.Token, nil), 200)
	h.srv.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	c.expect(c.do("GET", search+exp.Token, nil), 401)
	h.srv.now = time.Now

	// Owner disabled → rejected; enabled again → works; role follows the owner.
	adminTok := w.tokens["admin"]
	editorTok := w.tokens["editor"]
	c.expect(c.do("GET", withKey("/api/v2.0/server/logs", editorTok), nil), 302) // reached Jackett (no cookie: Jackett's login redirect)
	h.expect(h.do("PATCH", "/_ui/api/users/"+w.ids["editor"], map[string]any{"disabled": true}), 200)
	c.expect(c.do("GET", withKey("/api/v2.0/server/logs", editorTok), nil), 401)
	h.expect(h.do("PATCH", "/_ui/api/users/"+w.ids["editor"], map[string]any{"disabled": false, "role": "viewer"}), 200)
	c.expect(c.do("GET", withKey("/api/v2.0/server/logs", editorTok), nil), 403)
	c.expect(c.do("GET", search+editorTok, nil), 200)
	// Deleting the owner deletes the tokens.
	h.expect(h.do("DELETE", "/_ui/api/users/"+w.ids["editor"], nil, xhr), 204)
	c.expect(c.do("GET", search+editorTok, nil), 401)
	for _, st := range h.store.Get().Tokens {
		if st.UserID == w.ids["editor"] {
			t.Fatal("tokens of a deleted user kept")
		}
	}
	c.expect(c.do("GET", search+adminTok, nil), 200)

	// Validation and the per-user limit.
	for _, bad := range []map[string]any{{"name": ""}, {"name": strings.Repeat("x", 65)}, {"name": "a\nb"}, {"name": "x", "expiresInDays": 0}, {"name": "x", "expiresInDays": 4000}} {
		if res := viewer.do("POST", "/_ui/api/me/tokens", bad); res.Code != 400 {
			t.Fatalf("%v: %d", bad, res.Code)
		}
	}
	n := len(decode[[]tokenView](t, viewer.do("GET", "/_ui/api/me/tokens", nil)))
	for i := n; i < 20; i++ {
		viewer.newToken("t")
	}
	if res := viewer.do("POST", "/_ui/api/me/tokens", map[string]any{"name": "21st"}); res.Code != 409 || errorCode(res) != "too_many_tokens" {
		t.Fatalf("limit: %d", res.Code)
	}
	// Token formats that are not ours: refused without a store lookup hit.
	for _, bad := range []string{"jui_short", strings.Repeat("a", 36), "jui_" + strings.Repeat("A", 32)} {
		if res := c.do("GET", search+bad, nil); res.Code != 401 {
			t.Fatalf("%s: %d", bad, res.Code)
		}
	}
}

func TestSessionCookieForPasswordlessUser(t *testing.T) {
	h := newHarness(t, harnessOpt{})
	h.setup()
	id := h.createUser("sso1", "viewer", "")
	u := h.userByName("sso1")
	if u.PasswordHash != "" {
		t.Fatal("password set")
	}
	// No password: login refused (no enumeration: same error).
	if res := h.clone().loginAs("sso1", ""); res.Code != 401 || errorCode(res) != "invalid_credentials" {
		t.Fatalf("%d", res.Code)
	}
	c := h.clone()
	sess := h.srv.sessions.New(id, "password", u.Epoch, h.store.Get().AuthEpoch, time.Hour)
	c.jar[session.CookieName] = h.srv.sessions.Encode(sess)
	me := decode[meResponse](t, c.do("GET", "/_ui/api/me", nil))
	if me.User.PasswordSet || me.User.Username != "sso1" {
		t.Fatalf("me: %+v", me.User)
	}
	// Set the first password without "current".
	c.expect(c.do("POST", "/_ui/api/me/password", map[string]string{"new": "first-password"}), 204)
	h.clone().expect(h.clone().loginAs("sso1", "first-password"), 204)
	c.expect(c.do("GET", "/_ui/api/me", nil), 200) // caller kept a session
	// Now "current" is required.
	if res := c.do("POST", "/_ui/api/me/password", map[string]string{"new": "second-password"}); res.Code != 403 || errorCode(res) != "invalid_credentials" {
		t.Fatalf("%d", res.Code)
	}
	// A forged session for another user id / wrong epoch is rejected.
	bad := h.clone()
	bad.jar[session.CookieName] = h.srv.sessions.Encode(h.srv.sessions.New(id, "password", u.Epoch, h.store.Get().AuthEpoch, time.Hour))
	bad.expect(bad.do("GET", "/_ui/api/me", nil), 401) // epoch bumped by the password change
	_ = http.StatusOK
}
