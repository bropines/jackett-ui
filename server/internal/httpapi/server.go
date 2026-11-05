// Package httpapi is the HTTP front of jackett-ui: routing, authentication,
// authorization (roles, API tokens), CSRF, security headers, gzip, the
// /_ui/api endpoints, the external login flows, the Jackett proxy routes
// and the static UI.
package httpapi

import (
	"errors"
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
	"github.com/bropines/jackett-ui/server/internal/users"
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
	usage *tokenUsage
	// ceremonies: pending passkey ceremonies.
	ceremonies *ceremonies

	handler http.Handler
}

// New builds the server. If AUTH_PASSWORD[_HASH] is set, it makes sure the
// user "admin" exists (the env password is its password).
func New(o Options) (*Server, error) {
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
	if err := ensureEnvAdmin(o.Env, o.Store, o.Now(), o.Log); err != nil {
		return nil, err
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
		ceremonies:      newCeremonies(),
		usage:           newTokenUsage(),
	}
	s.sessions.Now = o.Now
	s.limiter.Now = o.Now
	s.factories = map[string]providerFactory{
		config.ProviderOIDC:   s.oidcFactory,
		config.ProviderGoogle: s.oidcFactory,
		config.ProviderGitHub: s.githubFactory,
	}
	s.handler = requestLog(s.log, http.HandlerFunc(s.serve))
	return s, nil
}

// ensureEnvAdmin binds AUTH_PASSWORD[_HASH] to the initial admin (the user
// with Bootstrap set). Before the first-login wizard ran, the user "admin"
// becomes that user (created if missing). Afterwards a missing initial admin
// (replaced in the wizard, or deleted) means the env password is ignored.
func ensureEnvAdmin(env *config.Env, st *store.Store, now time.Time, log *slog.Logger) error {
	if env.PasswordHash == "" {
		return nil
	}
	cur := st.Get()
	if users.BootstrapUser(&cur) != nil {
		return nil
	}
	if cur.Onboarded {
		log.Warn(env.PasswordVar + " is set but ignored: the initial admin was replaced. Remove it from the environment; " +
			`use "jackett-ui reset-password <user>" to recover access`)
		return nil
	}
	return st.Update(func(s *store.Settings) error {
		if users.BootstrapUser(s) != nil || s.Onboarded {
			return nil
		}
		if u := users.ByUsername(s, store.AdminUsername); u != nil {
			u.Bootstrap = true
			return nil
		}
		u := newUser(store.AdminUsername, "Администратор", store.RoleAdmin, "", now)
		u.Bootstrap = true
		s.Users = append(s.Users, u)
		return nil
	})
}

func newUser(username, name, role, hash string, now time.Time) store.User {
	return store.User{
		ID: store.NewID("u_"), Username: username, Name: name, Role: role, PasswordHash: hash,
		Identities: []store.Identity{}, Epoch: 1, CreatedAt: now.UTC().Truncate(time.Second),
	}
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }

// Flush persists pending token usage (call on shutdown).
func (s *Server) Flush() { s.flushUsage(true) }

// reqEnv is the per-request view of the configuration: one snapshot of the
// stored settings and the effective configuration derived from it.
type reqEnv struct {
	st  store.Settings
	eff config.Effective
	rv  netutil.Resolver
}

func (s *Server) newReqEnv() (*reqEnv, error) {
	st := s.store.Get()
	eff, err := config.Resolve(s.env, st)
	if err != nil {
		return nil, err
	}
	return &reqEnv{st: st, eff: eff, rv: s.resolver(eff)}, nil
}

func (s *Server) resolver(eff config.Effective) netutil.Resolver {
	return netutil.Resolver{Trusted: s.env.TrustedProxies, PublicURL: eff.PublicURLp}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	re, err := s.newReqEnv()
	if err != nil {
		s.log.Error("invalid settings", "error", err)
		setSecurityHeaders(w.Header(), "")
		writeErr(w, http.StatusInternalServerError, "invalid_settings", "Ошибка в файле настроек: "+err.Error())
		return
	}
	setSecurityHeaders(w.Header(), cspExtra(re.eff))
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

func writeCSRF(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "csrf", "Запрос отклонён (защита от CSRF)")
}

func writeForbidden(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "forbidden", "Недостаточно прав")
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeErr(w, http.StatusMethodNotAllowed, "method_not_allowed", "Метод не поддерживается")
}

func notFound(w http.ResponseWriter) {
	writeErr(w, http.StatusNotFound, "not_found", "Не найдено")
}

// ---- /_ui routes ----

// route table entry: method → handler.
type handlers map[string]func()

func dispatch(w http.ResponseWriter, r *http.Request, h handlers) {
	m := r.Method
	if m == http.MethodHead {
		m = http.MethodGet
	}
	if f, ok := h[m]; ok {
		f()
		return
	}
	var allow []string
	for k := range h {
		allow = append(allow, k)
	}
	methodNotAllowed(w, strings.Join(sortStrings(allow), ", "))
}

func sortStrings(l []string) []string {
	for i := range l {
		for j := i + 1; j < len(l); j++ {
			if l[j] < l[i] {
				l[i], l[j] = l[j], l[i]
			}
		}
	}
	return l
}

func (s *Server) uiRoute(w http.ResponseWriter, r *http.Request, p string, re *reqEnv) {
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
		notFound(w)
		return
	}
	rest, ok := strings.CutPrefix(p, "/_ui/api/")
	if !ok {
		notFound(w)
		return
	}
	seg := strings.Split(strings.TrimSuffix(rest, "/"), "/")

	// Public endpoints.
	switch {
	case rest == "auth/state":
		dispatch(w, r, handlers{"GET": func() { s.handleState(w, r, re) }})
		return
	case rest == "auth/setup" || rest == "auth/login" || rest == "auth/logout":
		dispatch(w, r, handlers{"POST": func() {
			if !csrfOK(r, re.rv) {
				writeCSRF(w)
				return
			}
			switch rest {
			case "auth/setup":
				s.handleSetup(w, r, re)
			case "auth/login":
				s.handleLogin(w, r, re)
			default:
				s.handleLogout(w, r, re)
			}
		}})
		return
	case rest == "auth/passkey/begin" || rest == "auth/passkey/finish":
		dispatch(w, r, handlers{"POST": func() {
			if !csrfOK(r, re.rv) {
				writeCSRF(w)
				return
			}
			if rest == "auth/passkey/begin" {
				s.handlePasskeyLoginBegin(w, r, re)
			} else {
				s.handlePasskeyLoginFinish(w, r, re)
			}
		}})
		return
	case len(seg) == 2 && seg[0] == "invites" && r.Method != http.MethodDelete:
		// GET /invites/{token} is public; DELETE /invites/{id} is admin.
		dispatch(w, r, handlers{"GET": func() { s.handleInvitePublic(w, r, re, seg[1]) }})
		return
	case len(seg) == 3 && seg[0] == "invites" && seg[2] == "accept":
		dispatch(w, r, handlers{"POST": func() {
			if !csrfOK(r, re.rv) {
				writeCSRF(w)
				return
			}
			s.handleInviteAccept(w, r, re, seg[1])
		}})
		return
	}

	// Protected endpoints: a session (or header login, or login disabled).
	// API tokens are never accepted here.
	pr, fail := s.authenticate(w, r, re)
	if fail != "" {
		writeAuthFail(w, fail)
		return
	}
	if !csrfOK(r, re.rv) {
		writeCSRF(w)
		return
	}
	admin := func(f func()) func() {
		return func() {
			if !pr.isAdmin() {
				writeForbidden(w)
				return
			}
			f()
		}
	}

	switch {
	case rest == "auth/logout-all":
		dispatch(w, r, handlers{"POST": func() { s.handleLogoutAll(w, r, re, pr) }})
	case rest == "onboarding":
		dispatch(w, r, handlers{"POST": func() { s.handleOnboarding(w, r, re, pr) }})

	// ---- me ----
	case rest == "me":
		dispatch(w, r, handlers{
			"GET":   func() { s.handleMe(w, r, re, pr) },
			"PATCH": func() { s.handleMePatch(w, r, re, pr) },
		})
	case rest == "me/password":
		dispatch(w, r, handlers{"POST": func() { s.handleMePassword(w, r, re, pr) }})
	case len(seg) == 3 && seg[0] == "me" && seg[1] == "identities":
		dispatch(w, r, handlers{"DELETE": func() { s.handleUnlink(w, r, re, pr, pr.uid(), seg[2]) }})
	case rest == "me/passkeys":
		dispatch(w, r, handlers{"GET": func() { s.handleMyPasskeys(w, re, pr) }})
	case rest == "me/passkeys/begin":
		dispatch(w, r, handlers{"POST": func() { s.handlePasskeyRegisterBegin(w, r, re, pr) }})
	case rest == "me/passkeys/finish":
		dispatch(w, r, handlers{"POST": func() { s.handlePasskeyRegisterFinish(w, r, re, pr) }})
	case len(seg) == 3 && seg[0] == "me" && seg[1] == "passkeys":
		dispatch(w, r, handlers{
			"PATCH":  func() { s.handlePasskeyRename(w, r, pr, seg[2]) },
			"DELETE": func() { s.handlePasskeyDelete(w, pr, pr.uid(), seg[2]) },
		})
	case rest == "me/tokens":
		dispatch(w, r, handlers{
			"GET":  func() { s.handleMyTokens(w, re, pr) },
			"POST": func() { s.handleTokenCreate(w, r, re, pr) },
		})
	case len(seg) == 3 && seg[0] == "me" && seg[1] == "tokens":
		dispatch(w, r, handlers{"DELETE": func() { s.handleTokenDelete(w, r, re, pr, seg[2], true) }})

	// ---- torrent preview (any role) ----
	case rest == "torrent/files":
		dispatch(w, r, handlers{"GET": func() { s.handleTorrentFiles(w, r, re, pr) }})

	// ---- users (admin) ----
	case rest == "users":
		dispatch(w, r, handlers{
			"GET":  admin(func() { s.handleUsersList(w, re) }),
			"POST": admin(func() { s.handleUserCreate(w, r, re, pr) }),
		})
	case len(seg) == 2 && seg[0] == "users":
		dispatch(w, r, handlers{
			"PATCH":  admin(func() { s.handleUserPatch(w, r, re, pr, seg[1]) }),
			"DELETE": admin(func() { s.handleUserDelete(w, r, re, pr, seg[1]) }),
		})
	case len(seg) == 3 && seg[0] == "users" && seg[2] == "logout":
		dispatch(w, r, handlers{"POST": admin(func() { s.handleUserLogout(w, r, re, pr, seg[1]) })})
	case len(seg) == 3 && seg[0] == "users" && seg[2] == "tokens":
		dispatch(w, r, handlers{"GET": admin(func() { s.handleUserTokens(w, re, seg[1]) })})
	case len(seg) == 4 && seg[0] == "users" && seg[2] == "identities":
		dispatch(w, r, handlers{"DELETE": admin(func() { s.handleUnlink(w, r, re, pr, seg[1], seg[3]) })})
	case len(seg) == 4 && seg[0] == "users" && seg[2] == "passkeys":
		dispatch(w, r, handlers{"DELETE": admin(func() { s.handlePasskeyDelete(w, pr, seg[1], seg[3]) })})
	case len(seg) == 2 && seg[0] == "tokens":
		dispatch(w, r, handlers{"DELETE": admin(func() { s.handleTokenDelete(w, r, re, pr, seg[1], false) })})

	// ---- invites (admin) ----
	case rest == "invites":
		dispatch(w, r, handlers{
			"GET":  admin(func() { s.handleInvitesList(w, re) }),
			"POST": admin(func() { s.handleInviteCreate(w, r, re, pr) }),
		})
	case len(seg) == 2 && seg[0] == "invites": // DELETE (others are public, above)
		dispatch(w, r, handlers{"DELETE": admin(func() { s.handleInviteDelete(w, r, re, pr, seg[1]) })})

	// ---- own trackers (admin) ----
	case rest == "definitions":
		dispatch(w, r, handlers{"GET": admin(func() { s.handleDefinitionsList(w) })})
	case rest == "definitions/reload":
		dispatch(w, r, handlers{"POST": admin(func() { s.handleDefinitionsReload(w, r, pr) })})
	case len(seg) == 2 && seg[0] == "definitions":
		dispatch(w, r, handlers{
			"GET":    admin(func() { s.handleDefinitionGet(w, seg[1]) }),
			"PUT":    admin(func() { s.handleDefinitionPut(w, r, pr, seg[1]) }),
			"DELETE": admin(func() { s.handleDefinitionDelete(w, pr, seg[1]) }),
		})

	// ---- settings (admin) ----
	case rest == "settings":
		dispatch(w, r, handlers{
			"GET": admin(func() { writeJSON(w, http.StatusOK, s.settingsView(r, re)) }),
			"PUT": admin(func() { s.handleSettingsPut(w, r, re, pr) }),
		})
	case strings.HasPrefix(rest, "settings/providers/"):
		if len(seg) < 4 || len(seg) > 5 || !config.ValidProvider(seg[2]) || seg[3] != "test" {
			notFound(w)
			return
		}
		if len(seg) == 4 {
			dispatch(w, r, handlers{"POST": admin(func() { s.handleProviderTest(w, r, re, seg[2]) })})
			return
		}
		dispatch(w, r, handlers{"GET": admin(func() { s.handleProviderTestStatus(w, seg[2], seg[4]) })})
	default:
		notFound(w)
	}
}

// errAPI helpers.
var errNoUser = &apiError{Status: http.StatusConflict, Code: "no_user", Message: "Вход отключён: нет учётной записи"}

func isAPIError(err error, code string) bool {
	var ae *apiError
	return errors.As(err, &ae) && ae.Code == code
}
