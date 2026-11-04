package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/proxy"
	"github.com/bropines/jackett-ui/server/internal/store"
	"github.com/bropines/jackett-ui/server/internal/users"
)

// ---- authorization: Jackett paths (spec §2) ----

// jackettMinRole returns the minimum role for method + lp (the cleaned,
// lower-cased path). Unknown paths need admin.
func jackettMinRole(method, lp string) string {
	get := method == http.MethodGet || method == http.MethodHead
	if strings.HasPrefix(lp, "/dl/") || strings.HasPrefix(lp, "/bh/") {
		if get {
			return store.RoleViewer
		}
		return store.RoleAdmin
	}
	rest, ok := strings.CutPrefix(strings.TrimSuffix(lp, "/"), "/api/v2.0/")
	if !ok {
		return store.RoleAdmin
	}
	seg := strings.Split(rest, "/")
	n := len(seg)
	if seg[0] == "indexers" {
		switch {
		case n == 1 && get:
			return store.RoleViewer
		case n == 2 && seg[1] == "cache" && get:
			return store.RoleEditor
		case n >= 3 && seg[1] != "" && seg[2] == "results" && get &&
			(n == 3 || seg[3] == "torznab" || seg[3] == "potato"):
			return store.RoleViewer
		case n == 3 && seg[1] != "" && seg[2] == "config" && (get || method == http.MethodPost):
			return store.RoleEditor
		case n == 3 && seg[1] != "" && seg[2] == "test" && method == http.MethodPost:
			return store.RoleEditor
		case n == 2 && seg[1] != "" && seg[1] != "cache" && method == http.MethodDelete:
			return store.RoleEditor
		}
	}
	if n == 2 && seg[0] == "server" && seg[1] == "logs" && get {
		return store.RoleEditor
	}
	return store.RoleAdmin
}

// isAPIKeyRoute: Jackett routes that authenticate with its API key:
// /api/v2.0/indexers/{id}/results[/...], /dl/*, /bh/*. Here the server
// injects the real key; it never sends its Jackett cookie.
func isAPIKeyRoute(lp string) bool {
	if strings.HasPrefix(lp, "/dl/") || strings.HasPrefix(lp, "/bh/") {
		return true
	}
	const pre = "/api/v2.0/indexers/"
	if !strings.HasPrefix(lp, pre) {
		return false
	}
	id, tail, ok := strings.Cut(lp[len(pre):], "/")
	if !ok || id == "" {
		return false
	}
	return tail == "results" || strings.HasPrefix(tail, "results/")
}

// ---- API key parameters ----

// keyParam reports whether a query parameter name carries an API key.
func keyParam(rawName string) bool {
	n, err := url.QueryUnescape(rawName)
	if err != nil {
		n = rawName
	}
	switch strings.ToLower(strings.TrimSpace(n)) {
	case "apikey", "jackett_apikey", "passkey":
		return true
	}
	return false
}

// sessionKey is the placeholder the UI uses instead of a key (and what
// Jackett's key becomes in responses to session requests).
const sessionKey = "session"

// presentedKey collects the key from apikey / jackett_apikey / passkey and
// X-Api-Key. All non-empty values must agree (ok=false otherwise).
func presentedKey(r *http.Request) (key string, ok bool) {
	var vals []string
	for _, part := range strings.Split(r.URL.RawQuery, "&") {
		name, val, _ := strings.Cut(part, "=")
		if !keyParam(name) {
			continue
		}
		v, err := url.QueryUnescape(val)
		if err != nil {
			return "", false
		}
		if v = strings.TrimSpace(v); v != "" {
			vals = append(vals, v)
		}
	}
	for _, v := range r.Header.Values("X-Api-Key") {
		if v = strings.TrimSpace(v); v != "" {
			vals = append(vals, v)
		}
	}
	for _, v := range vals {
		if v != vals[0] {
			return "", false
		}
	}
	if len(vals) == 0 {
		return "", true
	}
	return vals[0], true
}

// upstreamQuery rebuilds the query for Jackett: every key parameter is
// removed or (on API-key routes) set to the real key; on API-key routes
// without one, the key is added (apikey, or jackett_apikey for /dl /bh).
// Everything else is kept byte for byte.
func upstreamQuery(raw, lp, realKey string) string {
	keyRoute := isAPIKeyRoute(lp)
	var parts []string
	had := false
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		name, _, _ := strings.Cut(part, "=")
		if keyParam(name) {
			if keyRoute {
				parts = append(parts, name+"="+url.QueryEscape(realKey))
				had = true
			}
			continue
		}
		parts = append(parts, part)
	}
	if keyRoute && !had {
		p := "apikey"
		if strings.HasPrefix(lp, "/dl/") || strings.HasPrefix(lp, "/bh/") {
			p = "jackett_apikey"
		}
		parts = append(parts, p+"="+url.QueryEscape(realKey))
	}
	return strings.Join(parts, "&")
}

func writeInvalidToken(w http.ResponseWriter) {
	writeErr(w, http.StatusUnauthorized, "invalid_token", "Неверный или отозванный API-токен")
}

// tokenPrincipal checks an API token: known, not expired, owner enabled.
func (s *Server) tokenPrincipal(re *reqEnv, tok string) *principal {
	t := users.FindToken(&re.st, tok)
	if t == nil || (t.ExpiresAt != nil && !s.now().Before(*t.ExpiresAt)) {
		return nil
	}
	u := re.st.User(t.UserID)
	if u == nil || u.Disabled {
		return nil
	}
	return &principal{user: u, role: u.Role, via: viaToken, token: t}
}

// ---- the Jackett route ----

func (s *Server) jackettRoute(w http.ResponseWriter, r *http.Request, p, lp string, re *reqEnv) {
	if badPath(p) {
		writeErr(w, http.StatusBadRequest, "bad_path", "Некорректный путь")
		return
	}
	switch strings.TrimSuffix(lp, "/") {
	case "/ui/dashboard", "/ui/login":
		// Jackett's own login pages would bypass our auth.
		notFound(w)
		return
	case "/ui/logout":
		s.clearSession(w, r, re)
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}

	key, ok := presentedKey(r)
	if !ok {
		writeInvalidToken(w)
		return
	}
	var pr *principal
	switch {
	case key == "":
		var fail string
		if pr, fail = s.authenticate(w, r, re); fail != "" {
			writeAuthFail(w, fail)
			return
		}
	case re.eff.SetupRequired():
		// Secure by default: no Jackett before the first admin exists.
		writeAuthFail(w, failSetupRequired)
		return
	case key == sessionKey:
		// The UI's placeholder: only with a valid session.
		var fail string
		if pr, fail = s.authenticate(w, r, re); fail != "" {
			writeAuthFail(w, fail)
			return
		}
	default:
		// A jui_ token. Anything else (Jackett's own key included) is refused.
		if pr = s.tokenPrincipal(re, key); pr == nil {
			s.log.Debug("invalid api token", "ip", re.rv.ClientIP(r).String(), "path", p)
			writeInvalidToken(w)
			return
		}
	}

	if config.RoleRank(pr.role) < config.RoleRank(jackettMinRole(r.Method, lp)) {
		writeForbidden(w)
		return
	}
	// Tokens carry no ambient credentials; sessions and header logins do.
	if pr.via != viaToken && !csrfOK(r, re.rv) {
		writeCSRF(w)
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

	query := upstreamQuery(r.URL.RawQuery, lp, realKey)
	repl := sessionKey
	if pr.via == viaToken {
		repl = key
		s.recordUsage(pr.token.ID, re.rv.ClientIP(r).String())
	}
	isConfig := strings.TrimSuffix(lp, "/") == "/api/v2.0/server/config"
	opts := proxy.Options{
		Path: p, Proto: re.rv.Scheme(r), Host: re.rv.Host(r), For: re.rv.ForwardedFor(r),
		RawQuery:   &query,
		WithCookie: pr.via != viaToken && !isAPIKeyRoute(lp),
		Rewrite:    &proxy.Rewrite{Key: realKey, Replacement: repl, HideConfigKey: isConfig},
	}
	if isConfig && r.Method == http.MethodPost {
		if err := restoreConfigKey(r, realKey); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "Не удалось прочитать тело запроса")
			return
		}
	}
	s.proxy.Serve(w, r, opts)
	if r.Method != http.MethodGet && r.Method != http.MethodHead && strings.HasPrefix(lp, "/api/v2.0/server/") {
		// The key may have changed: read it again before the next request.
		s.jc.InvalidateAPIKey()
	}
}

// restoreConfigKey: the UI posts server/config back with api_key
// "(hidden)"; put the real key back so Jackett never stores the placeholder.
func restoreConfigKey(r *http.Request, realKey string) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20+1))
	_ = r.Body.Close()
	if err != nil {
		return err
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(body, &m) == nil {
		if v, ok := m["api_key"]; ok {
			var sv string
			if json.Unmarshal(v, &sv) == nil && (sv == proxy.HiddenKey || sv == sessionKey) {
				b, _ := json.Marshal(realKey)
				m["api_key"] = b
				if nb, err := json.Marshal(m); err == nil {
					body = nb
				}
			}
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	return nil
}
