// Package httpapi is the HTTP front of jackett-ui: routing, authentication,
// CSRF, security headers, gzip, the /_ui/api endpoints, the external login
// flows, the Jackett proxy routes and the static UI.
package httpapi

import (
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/bropines/jackett-ui/server/internal/auth"
	"github.com/bropines/jackett-ui/server/internal/auth/github"
	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/jackett"
	"github.com/bropines/jackett-ui/server/internal/netutil"
	"github.com/bropines/jackett-ui/server/internal/proxy"
	"github.com/bropines/jackett-ui/server/internal/session"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// Options configure a Server.
type Options struct {
	Env     *config.Env
	Store   *store.Store
	Jackett *jackett.Client
	Proxy   *proxy.Proxy
	// Static is the UI root (must contain index.html).
	Static  fs.FS
	Version string
	Log     *slog.Logger
	// HTTPClient is used for IdP calls (discovery, token, userinfo).
	// nil = a client with a 10 s timeout.
	HTTPClient *http.Client
	// GoogleIssuer overrides the google issuer (tests).
	GoogleIssuer string
	// GitHubEndpoints overrides the GitHub endpoints (tests).
	GitHubEndpoints github.Endpoints
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Server is the jackett-ui HTTP handler.
type Server struct {
	env     *config.Env
	store   *store.Store
	jc      *jackett.Client
	proxy   *proxy.Proxy
	static  *staticHandler
	version string
	log     *slog.Logger
	now     func() time.Time

	sessions   *session.Manager
	flowSigner *session.Signer
	limiter    *auth.Limiter

	httpClient      *http.Client
	googleIssuer    string
	githubEndpoints github.Endpoints
	factories       map[string]providerFactory

	provMu    sync.Mutex
	provCache map[string]*provEntry

	tests *testFlows

	handler http.Handler
}

// New builds the server.
func New(o Options) *Server {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.HTTPClient == nil {
		o.HTTPClient = &http.Client{Timeout: 10 * time.Second}
	}
	if o.GoogleIssuer == "" {
		o.GoogleIssuer = config.GoogleIssuer
	}
	key := o.Store.Get().SessionKey
	s := &Server{
		env:             o.Env,
		store:           o.Store,
		jc:              o.Jackett,
		proxy:           o.Proxy,
		static:          newStatic(o.Static),
		version:         o.Version,
		log:             o.Log,
		now:             o.Now,
		sessions:        session.NewManager(key),
		flowSigner:      session.NewSigner(key, "login-flow"),
		limiter:         auth.NewLimiter(),
		httpClient:      o.HTTPClient,
		googleIssuer:    o.GoogleIssuer,
		githubEndpoints: o.GitHubEndpoints,
		provCache:       map[string]*provEntry{},
		tests:           newTestFlows(),
	}
	s.sessions.Now = o.Now
	s.limiter.Now = o.Now
	s.factories = map[string]providerFactory{
		config.ProviderOIDC:   s.oidcFactory,
		config.ProviderGoogle: s.oidcFactory,
		config.ProviderGitHub: s.githubFactory,
	}
	s.handler = requestLog(s.log, http.HandlerFunc(s.serve))
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

// reqEnv is the per-request view of the configuration.
type reqEnv struct {
	eff config.Effective
	rv  netutil.Resolver
}

func (s *Server) effective() (config.Effective, error) {
	return config.Resolve(s.env, s.store.Get())
}

func (s *Server) resolver(eff config.Effective) netutil.Resolver {
	return netutil.Resolver{Trusted: s.env.TrustedProxies, PublicURL: eff.PublicURLp}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	eff, err := s.effective()
	if err != nil {
		s.log.Error("invalid settings", "error", err)
		setSecurityHeaders(w.Header(), "")
		writeErr(w, http.StatusInternalServerError, "invalid_settings", "Ошибка в файле настроек: "+err.Error())
		return
	}
	setSecurityHeaders(w.Header(), cspExtra(eff))
	re := &reqEnv{eff: eff, rv: s.resolver(eff)}
	gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.route(w, r, re)
	})).ServeHTTP(w, r)
}

// cspExtra returns the origins added to form-action: the enabled
// providers' authorization servers.
func cspExtra(eff config.Effective) string {
	var origins []string
	for _, p := range eff.EnabledProviders() {
		var o string
		switch p.ID {
		case config.ProviderGitHub:
			o = "https://github.com"
		default:
			if u, err := url.Parse(p.Issuer.Value); err == nil && u.Host != "" && (u.Scheme == "https" || u.Scheme == "http") {
				o = u.Scheme + "://" + u.Host
			}
		}
		if o != "" {
			origins = append(origins, o)
		}
	}
	return strings.Join(origins, " ")
}

// cleanPath normalises the request path (dot segments, duplicate slashes)
// and keeps a trailing slash. Routing decisions and the path sent to
// Jackett both use the result, so they can't disagree.
func cleanPath(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		p = "/" + p
	}
	c := path.Clean(p)
	if strings.HasSuffix(p, "/") && c != "/" {
		c += "/"
	}
	return c
}

func isJackettPath(lp string) bool {
	for _, pre := range []string{"/api", "/dl", "/bh", "/ui"} {
		if lp == pre || strings.HasPrefix(lp, pre+"/") {
			return true
		}
	}
	return false
}

// isAPIKeyRoute: Jackett routes that authenticate with the API key:
// /api/v2.0/indexers/{id}/results[/...], /dl/*, /bh/*.
func isAPIKeyRoute(lp string) bool {
	if strings.HasPrefix(lp, "/dl/") || strings.HasPrefix(lp, "/bh/") {
		return true
	}
	const pre = "/api/v2.0/indexers/"
	if !strings.HasPrefix(lp, pre) {
		return false
	}
	rest := lp[len(pre):]
	id, tail, ok := strings.Cut(rest, "/")
	if !ok || id == "" {
		return false
	}
	return tail == "results" || strings.HasPrefix(tail, "results/")
}

func hasAPIKey(r *http.Request) bool {
	for k, vs := range r.URL.Query() {
		if strings.EqualFold(k, "apikey") || strings.EqualFold(k, "jackett_apikey") {
			for _, v := range vs {
				if strings.TrimSpace(v) != "" {
					return true
				}
			}
		}
	}
	return false
}

func badPath(p string) bool {
	for _, c := range p {
		if c < 0x20 || c == 0x7f || c == '\\' {
			return true
		}
	}
	return false
}

func (s *Server) route(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	p := cleanPath(r.URL.Path)
	lp := strings.ToLower(p)
	switch {
	case lp == "/healthz":
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok\n"))
	case p == "/_ui" || strings.HasPrefix(p, "/_ui/"):
		s.uiRoute(w, r, p, re)
	case isJackettPath(lp):
		s.jackettRoute(w, r, p, lp, re)
	default:
		s.static.ServeHTTP(w, r, p)
	}
}

// ---- authentication ----

const (
	failUnauthorized  = "unauthorized"
	failSetupRequired = "setup_required"
)

// authenticate returns the caller's identity, or a failure code. Valid
// sessions past half their lifetime are renewed (sliding).
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, re *reqEnv) (auth.Identity, string) {
	eff := re.eff
	if eff.SetupRequired() {
		return auth.Identity{}, failSetupRequired
	}
	switch eff.Mode.Value {
	case auth.ModeNone:
		id, _ := auth.None{}.Authenticate(r)
		return id, ""
	case auth.ModeHeader:
		h := auth.Header{Name: eff.HeaderName.Value, Trusted: eff.HeaderPrefixes}
		if id, ok := h.Authenticate(r); ok {
			return id, ""
		}
		return auth.Identity{}, failUnauthorized
	}
	c, err := r.Cookie(session.CookieName)
	if err != nil || c.Value == "" {
		return auth.Identity{}, failUnauthorized
	}
	sess, ok := s.sessions.Decode(c.Value, eff.Mode.Value, eff.Epoch)
	if !ok {
		return auth.Identity{}, failUnauthorized
	}
	ttl := eff.SessionTTL.Value
	if w != nil && s.sessions.NeedsRenewal(sess, ttl) {
		http.SetCookie(w, s.sessions.Cookie(s.sessions.New(sess.User, sess.Mode, sess.Epoch, ttl), re.rv.Secure(r)))
	}
	return auth.Identity{User: sess.User, Mode: sess.Mode, FromSession: true}, ""
}

func writeAuthFail(w http.ResponseWriter, code string) {
	if code == failSetupRequired {
		writeErr(w, http.StatusUnauthorized, failSetupRequired, "Сначала задайте пароль администратора")
		return
	}
	writeErr(w, http.StatusUnauthorized, failUnauthorized, "Нужно войти")
}

func writeCSRF(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "csrf", "Запрос отклонён (защита от CSRF)")
}

// issueSession sets a fresh session cookie.
func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, re *reqEnv, user, mode string, epoch uint64) {
	sess := s.sessions.New(user, mode, epoch, re.eff.SessionTTL.Value)
	http.SetCookie(w, s.sessions.Cookie(sess, re.rv.Secure(r)))
}

func (s *Server) clearSession(w http.ResponseWriter, r *http.Request, re *reqEnv) {
	http.SetCookie(w, session.ClearCookie(re.rv.Secure(r)))
}

// ---- Jackett routes ----

func (s *Server) jackettRoute(w http.ResponseWriter, r *http.Request, p, lp string, re *reqEnv) {
	if badPath(p) {
		writeErr(w, http.StatusBadRequest, "bad_path", "Некорректный путь")
		return
	}
	switch strings.TrimSuffix(lp, "/") {
	case "/ui/dashboard", "/ui/login":
		// Jackett's own login pages would bypass our auth.
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
		return
	case "/ui/logout":
		s.clearSession(w, r, re)
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	// Secure by default: Jackett is unreachable until setup is done, also
	// for API-key routes.
	if re.eff.SetupRequired() {
		writeAuthFail(w, failSetupRequired)
		return
	}
	opts := proxy.Options{Path: p, Proto: re.rv.Scheme(r), Host: re.rv.Host(r), For: re.rv.ForwardedFor(r)}
	if isAPIKeyRoute(lp) {
		// Jackett checks the key itself. Never attach our Jackett cookie.
		// No CSRF check: no ambient credentials are forwarded.
		if !hasAPIKey(r) {
			if _, fail := s.authenticate(w, r, re); fail != "" {
				writeAuthFail(w, fail)
				return
			}
		}
		opts.WithCookie = false
		s.proxy.Serve(w, r, opts)
		return
	}
	if _, fail := s.authenticate(w, r, re); fail != "" {
		writeAuthFail(w, fail)
		return
	}
	if !csrfOK(r, re.rv) {
		writeCSRF(w)
		return
	}
	opts.WithCookie = true
	s.proxy.Serve(w, r, opts)
}

// ---- /_ui routes ----

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "Метод не поддерживается")
}

func (s *Server) uiRoute(w http.ResponseWriter, r *http.Request, p string, re *reqEnv) {
	// Public endpoints.
	switch p {
	case "/_ui/api/auth/state":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w, "GET")
			return
		}
		s.handleState(w, r, re)
		return
	case "/_ui/api/auth/setup", "/_ui/api/auth/login", "/_ui/api/auth/logout":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		if !csrfOK(r, re.rv) {
			writeCSRF(w)
			return
		}
		switch p {
		case "/_ui/api/auth/setup":
			s.handleSetup(w, r, re)
		case "/_ui/api/auth/login":
			s.handleLogin(w, r, re)
		default:
			s.handleLogout(w, r, re)
		}
		return
	}
	if rest, ok := strings.CutPrefix(p, "/_ui/auth/"); ok {
		id, action, _ := strings.Cut(rest, "/")
		if config.ValidProvider(id) && (action == "start" || action == "callback") {
			if r.Method != http.MethodGet {
				methodNotAllowed(w, "GET")
				return
			}
			if action == "start" {
				s.handleProviderStart(w, r, re, id)
			} else {
				s.handleProviderCallback(w, r, re, id)
			}
			return
		}
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
		return
	}
	if !strings.HasPrefix(p, "/_ui/api/") {
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
		return
	}

	// Protected endpoints.
	id, fail := s.authenticate(w, r, re)
	if fail != "" {
		writeAuthFail(w, fail)
		return
	}
	if !csrfOK(r, re.rv) {
		writeCSRF(w)
		return
	}
	switch {
	case p == "/_ui/api/auth/logout-all":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return
		}
		s.handleLogoutAll(w, r, re, id)
	case p == "/_ui/api/settings":
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			writeJSON(w, http.StatusOK, s.settingsView(r, re))
		case http.MethodPut:
			s.handleSettingsPut(w, r, re, id)
		default:
			methodNotAllowed(w, "GET, PUT")
		}
	case strings.HasPrefix(p, "/_ui/api/settings/providers/"):
		rest := strings.TrimPrefix(p, "/_ui/api/settings/providers/")
		parts := strings.Split(rest, "/")
		if len(parts) < 2 || !config.ValidProvider(parts[0]) || parts[1] != "test" || len(parts) > 3 {
			writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
			return
		}
		if len(parts) == 2 {
			if r.Method != http.MethodPost {
				methodNotAllowed(w, "POST")
				return
			}
			s.handleProviderTest(w, r, re, parts[0])
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		s.handleProviderTestStatus(w, parts[0], parts[2])
	default:
		writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
	}
}
