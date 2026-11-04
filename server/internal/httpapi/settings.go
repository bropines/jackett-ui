package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bropines/jackett-ui/server/internal/config"
	"github.com/bropines/jackett-ui/server/internal/netutil"
	"github.com/bropines/jackett-ui/server/internal/store"
)

// ---- GET ----

type fieldView struct {
	Value  any    `json:"value"`
	Locked bool   `json:"locked"`
	Env    string `json:"env,omitempty"` // the variable that locks it
}

func fv[T any](f config.Field[T]) fieldView {
	return fieldView{Value: f.Value, Locked: f.Locked, Env: f.Env}
}

func (s *Server) settingsView(r *http.Request, re *reqEnv) map[string]any {
	eff := re.eff
	origin := re.rv.Origin(r)
	providers := map[string]any{}
	for _, id := range config.ProviderIDs {
		p := eff.Providers[id]
		v := map[string]any{
			"clientId":        fv(p.ClientID),
			"clientSecretSet": fieldView{Value: p.ClientSecret.Value != "", Locked: p.ClientSecret.Locked, Env: p.ClientSecret.Env},
			"name":            p.Name.Value,
			"redirectUrl":     redirectURL(origin, id),
			"enabled":         p.Enabled(),
			"verified":        p.Verified(),
		}
		if id == config.ProviderOIDC {
			v["issuer"] = fv(p.Issuer)
			v["providerName"] = fv(p.Name)
			v["scopes"] = fv(p.Scopes)
			v["allowedGroups"] = fv(p.Groups)
			v["groupsClaim"] = fv(p.GroupsClaim)
			v["allowUnverifiedEmail"] = fv(p.AllowUnverifiedEmail)
		}
		providers[id] = v
	}
	methods := map[string]fieldView{}
	for _, id := range config.MethodIDs {
		methods[id] = fieldView{Value: eff.Methods.Value.Get(id), Locked: eff.Methods.Locked, Env: eff.Methods.Env}
	}
	return map[string]any{
		"auth": map[string]any{
			"methods":  methods,
			"disabled": fv(eff.Disabled),
			"autoProvision": map[string]any{
				"enabled": fv(eff.AutoProvision),
				"role":    fv(eff.DefaultRole),
			},
			"allowedEmails": fv(eff.AllowedEmails),
			"adminEmails":   fv(eff.AdminEmails),
			"githubUsers":   fv(eff.GitHubUsers),
			"providers":     providers,
			"header": map[string]any{
				"name":    fv(eff.HeaderName),
				"trusted": fv(eff.HeaderTrusted),
			},
		},
		"publicUrl":  fv(eff.PublicURL),
		"sessionTtl": fieldView{Value: config.SessionTTLString(eff.SessionTTL.Value), Locked: eff.SessionTTL.Locked, Env: eff.SessionTTL.Env},
	}
}

// ---- PUT ----

// opt distinguishes omitted (Set=false), null (Null) and a value.
type opt[T any] struct {
	Set  bool
	Null bool
	V    T
}

func (o *opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Null = true
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

type putProvider struct {
	Issuer        opt[string]   `json:"issuer"`
	ClientID      opt[string]   `json:"clientId"`
	ClientSecret  opt[string]   `json:"clientSecret"`
	ProviderName  opt[string]   `json:"providerName"`
	Scopes        opt[string]   `json:"scopes"`
	AllowedGroups opt[[]string] `json:"allowedGroups"`
	GroupsClaim   opt[string]   `json:"groupsClaim"`
	// AllowUnverifiedEmail (oidc only).
	AllowUnverifiedEmail opt[bool] `json:"allowUnverifiedEmail"`
}

type putHeader struct {
	Name    opt[string]   `json:"name"`
	Trusted opt[[]string] `json:"trusted"`
}

type putMethods struct {
	Password opt[bool] `json:"password"`
	OIDC     opt[bool] `json:"oidc"`
	Google   opt[bool] `json:"google"`
	GitHub   opt[bool] `json:"github"`
	Header   opt[bool] `json:"header"`
}

func (m *putMethods) get(id string) opt[bool] {
	switch id {
	case "password":
		return m.Password
	case config.ProviderOIDC:
		return m.OIDC
	case config.ProviderGoogle:
		return m.Google
	case config.ProviderGitHub:
		return m.GitHub
	case "header":
		return m.Header
	}
	return opt[bool]{}
}

type putAutoProvision struct {
	Enabled opt[bool]   `json:"enabled"`
	Role    opt[string] `json:"role"`
}

type putAuth struct {
	Methods       *putMethods       `json:"methods"`
	Disabled      opt[bool]         `json:"disabled"`
	AutoProvision *putAutoProvision `json:"autoProvision"`
	AllowedEmails opt[[]string]     `json:"allowedEmails"`
	AdminEmails   opt[[]string]     `json:"adminEmails"`
	GitHubUsers   opt[[]string]     `json:"githubUsers"`
	Providers     *struct {
		OIDC   *putProvider `json:"oidc"`
		Google *putProvider `json:"google"`
		GitHub *putProvider `json:"github"`
	} `json:"providers"`
	Header  *putHeader `json:"header"`
	Confirm bool       `json:"confirm"`
}

type putRequest struct {
	Auth       *putAuth    `json:"auth"`
	PublicURL  opt[string] `json:"publicUrl"`
	SessionTTL opt[string] `json:"sessionTtl"`
	Confirm    bool        `json:"confirm"` // alias of auth.confirm
}

func validText(s string, max int) bool {
	if len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

// applyString applies o to *dst respecting the lock on f. For secrets, ""
// means "unchanged" and values are not trimmed.
func applyString(field string, o opt[string], f config.Field[string], dst *string, secret bool, validate func(string) error) error {
	if !o.Set {
		return nil
	}
	v := o.V
	if !secret {
		v = strings.TrimSpace(v)
	}
	if f.Locked {
		if secret {
			if o.Null || v != "" {
				return lockedErr(field, f.Env)
			}
			return nil
		}
		if o.Null || v != f.Value {
			return lockedErr(field, f.Env)
		}
		return nil
	}
	if o.Null {
		*dst = ""
		return nil
	}
	if secret && v == "" {
		return nil
	}
	if v != "" && validate != nil {
		if err := validate(v); err != nil {
			return err
		}
	}
	*dst = v
	return nil
}

func cleanList(field string, in []string, maxItems, maxLen int) ([]string, error) {
	out := []string{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !validText(s, maxLen) {
			return nil, badField(field, "Недопустимое значение в списке")
		}
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	if len(out) > maxItems {
		return nil, badField(field, fmt.Sprintf("Слишком много значений (максимум %d)", maxItems))
	}
	return out, nil
}

func applyList(field string, o opt[[]string], f config.Field[[]string], dst *[]string, validate func([]string) error) error {
	if !o.Set {
		return nil
	}
	var v []string
	if !o.Null {
		var err error
		if v, err = cleanList(field, o.V, 500, 256); err != nil {
			return err
		}
	}
	if f.Locked {
		if !slices.Equal(v, f.Value) && !(len(v) == 0 && len(f.Value) == 0) {
			return lockedErr(field, f.Env)
		}
		return nil
	}
	if validate != nil {
		if err := validate(v); err != nil {
			return err
		}
	}
	*dst = v
	return nil
}

func textValidator(field string, max int) func(string) error {
	return func(v string) error {
		if !validText(v, max) {
			return badField(field, "Недопустимое значение")
		}
		return nil
	}
}

func validateIssuer(field string) func(string) error {
	return func(v string) error {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return badField(field, "Issuer должен быть адресом вида https://auth.example.com/…")
		}
		return nil
	}
}

// applyProvider applies in to the stored provider id.
func applyProvider(id string, in *putProvider, cur config.Provider, sp *store.Provider) error {
	if in == nil {
		return nil
	}
	pre := "auth.providers." + id + "."
	if id != config.ProviderOIDC {
		for name, set := range map[string]bool{"issuer": in.Issuer.Set, "providerName": in.ProviderName.Set, "scopes": in.Scopes.Set,
			"allowedGroups": in.AllowedGroups.Set, "groupsClaim": in.GroupsClaim.Set, "allowUnverifiedEmail": in.AllowUnverifiedEmail.Set} {
			if set {
				return badField(pre+name, "Поле не поддерживается этим провайдером")
			}
		}
	}
	if err := applyString(pre+"clientId", in.ClientID, cur.ClientID, &sp.ClientID, false, textValidator(pre+"clientId", 512)); err != nil {
		return err
	}
	if err := applyString(pre+"clientSecret", in.ClientSecret, cur.ClientSecret, &sp.ClientSecret, true, textValidator(pre+"clientSecret", 1024)); err != nil {
		return err
	}
	if id != config.ProviderOIDC {
		return nil
	}
	if err := applyString(pre+"issuer", in.Issuer, cur.Issuer, &sp.Issuer, false, validateIssuer(pre+"issuer")); err != nil {
		return err
	}
	if err := applyString(pre+"providerName", in.ProviderName, cur.Name, &sp.ProviderName, false, textValidator(pre+"providerName", 64)); err != nil {
		return err
	}
	if err := applyString(pre+"scopes", in.Scopes, cur.Scopes, &sp.Scopes, false, textValidator(pre+"scopes", 512)); err != nil {
		return err
	}
	if err := applyString(pre+"groupsClaim", in.GroupsClaim, cur.GroupsClaim, &sp.GroupsClaim, false, textValidator(pre+"groupsClaim", 128)); err != nil {
		return err
	}
	if o := in.AllowUnverifiedEmail; o.Set {
		f := cur.AllowUnverifiedEmail
		switch {
		case f.Locked:
			if o.Null || o.V != f.Value {
				return lockedErr(pre+"allowUnverifiedEmail", f.Env)
			}
		case o.Null:
			sp.AllowUnverifiedEmail = false
		default:
			sp.AllowUnverifiedEmail = o.V
		}
	}
	return applyList(pre+"allowedGroups", in.AllowedGroups, cur.Groups, &sp.AllowedGroups, nil)
}

func (a *putAuth) provider(id string) *putProvider {
	if a == nil || a.Providers == nil {
		return nil
	}
	switch id {
	case config.ProviderOIDC:
		return a.Providers.OIDC
	case config.ProviderGoogle:
		return a.Providers.Google
	case config.ProviderGitHub:
		return a.Providers.GitHub
	}
	return nil
}

// applyBool applies o to *dst respecting the lock on f.
func applyBool(field string, o opt[bool], f config.Field[bool], dst *bool) error {
	if !o.Set {
		return nil
	}
	if f.Locked {
		if o.Null || o.V != f.Value {
			return lockedErr(field, f.Env)
		}
		return nil
	}
	if o.Null {
		*dst = false
		return nil
	}
	*dst = o.V
	return nil
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request, re *reqEnv, pr *principal) {
	var req putRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeAPIError(w, err)
		return
	}
	a := req.Auth
	if a == nil {
		a = &putAuth{}
	}
	confirm := a.Confirm || req.Confirm

	var cur, next config.Effective
	err := s.store.Update(func(st *store.Settings) error {
		var err error
		if cur, err = config.Resolve(s.env, *st); err != nil {
			return err
		}

		// Login methods (AUTH_METHODS / AUTH_MODE lock the whole block).
		if m := a.Methods; m != nil {
			for _, id := range config.MethodIDs {
				o := m.get(id)
				if !o.Set {
					continue
				}
				v := o.Set && !o.Null && o.V
				if cur.Methods.Locked {
					if v != cur.Methods.Value.Get(id) {
						return lockedErr("auth.methods."+id, cur.Methods.Env)
					}
					continue
				}
				*st.Auth.Methods.Ptr(id) = v
			}
		}
		if err := applyBool("auth.disabled", a.Disabled, cur.Disabled, &st.Auth.Disabled); err != nil {
			return err
		}
		if ap := a.AutoProvision; ap != nil {
			if err := applyBool("auth.autoProvision.enabled", ap.Enabled, cur.AutoProvision, &st.Auth.AutoProvision.Enabled); err != nil {
				return err
			}
			if ap.Role.Set && !ap.Role.Null {
				ap.Role.V = strings.ToLower(strings.TrimSpace(ap.Role.V))
			}
			if err := applyString("auth.autoProvision.role", ap.Role, cur.DefaultRole, &st.Auth.AutoProvision.Role, false, func(v string) error {
				if !config.ValidRole(v) {
					return badField("auth.autoProvision.role", "Роль: viewer, editor или admin")
				}
				return nil
			}); err != nil {
				return err
			}
			if st.Auth.AutoProvision.Role == "" {
				st.Auth.AutoProvision.Role = store.RoleViewer
			}
		}
		if err := applyList("auth.allowedEmails", a.AllowedEmails, cur.AllowedEmails, &st.Auth.AllowedEmails, nil); err != nil {
			return err
		}
		if err := applyList("auth.adminEmails", a.AdminEmails, cur.AdminEmails, &st.Auth.AdminEmails, nil); err != nil {
			return err
		}
		if err := applyList("auth.githubUsers", a.GitHubUsers, cur.GitHubUsers, &st.Auth.GitHubUsers, nil); err != nil {
			return err
		}
		for _, pid := range config.ProviderIDs {
			if err := applyProvider(pid, a.provider(pid), cur.Providers[pid], st.Auth.Providers.Get(pid)); err != nil {
				return err
			}
		}
		if h := a.Header; h != nil {
			if err := applyString("auth.header.name", h.Name, cur.HeaderName, &st.Auth.Header.Name, false, func(v string) error {
				if !config.ValidHeaderName(v) {
					return badField("auth.header.name", "Недопустимое имя заголовка")
				}
				return nil
			}); err != nil {
				return err
			}
			if err := applyList("auth.header.trusted", h.Trusted, cur.HeaderTrusted, &st.Auth.Header.Trusted, func(l []string) error {
				if _, err := netutil.ParsePrefixList(l); err != nil {
					return badField("auth.header.trusted", "Некорректный CIDR: "+err.Error())
				}
				return nil
			}); err != nil {
				return err
			}
		}
		if err := applyString("publicUrl", req.PublicURL, cur.PublicURL, &st.PublicURL, false, func(v string) error {
			if _, err := config.ParsePublicURL(v); err != nil {
				return badField("publicUrl", "Некорректный адрес: "+err.Error())
			}
			return nil
		}); err != nil {
			return err
		}
		if st.PublicURL != "" && !cur.PublicURL.Locked {
			u, _ := config.ParsePublicURL(st.PublicURL)
			st.PublicURL = u.String()
		}
		curTTL := config.Field[string]{Value: config.SessionTTLString(cur.SessionTTL.Value), Locked: cur.SessionTTL.Locked, Env: cur.SessionTTL.Env}
		if cur.SessionTTL.Locked && req.SessionTTL.Set && !req.SessionTTL.Null {
			// Compare as durations ("168h" == "168h0m0s").
			if d, err := time.ParseDuration(strings.TrimSpace(req.SessionTTL.V)); err == nil && d == cur.SessionTTL.Value {
				req.SessionTTL.V = curTTL.Value
			}
		}
		if err := applyString("sessionTtl", req.SessionTTL, curTTL, &st.SessionTTL, false, func(v string) error {
			if _, err := config.ParseSessionTTL(v); err != nil {
				return badField("sessionTtl", "Некорректная длительность: "+err.Error())
			}
			return nil
		}); err != nil {
			return err
		}

		if next, err = config.Resolve(s.env, *st); err != nil {
			return badField("", err.Error())
		}

		// Rules for switching methods on.
		for _, id := range config.ProviderIDs {
			if next.Methods.Value.Get(id) && !cur.Methods.Value.Get(id) && !next.ProviderReady(id) {
				return &apiError{Status: http.StatusConflict, Code: "provider_not_ready", Field: "auth.methods." + id,
					Message: "Сначала настройте и проверьте вход через этого провайдера"}
			}
		}
		if next.Methods.Value.Header && !cur.Methods.Value.Header && len(next.HeaderPrefixes) == 0 {
			return &apiError{Status: http.StatusBadRequest, Code: "header_trusted_required", Message: "Укажите доверенные адреса прокси", Field: "auth.header.trusted"}
		}
		if next.Disabled.Value && !cur.Disabled.Value && !confirm {
			return &apiError{Status: http.StatusBadRequest, Code: "confirm_required", Message: "Отключение входа нужно подтвердить (confirm: true)", Field: "auth.disabled"}
		}
		// Every change that touches logins must leave an admin a way in.
		touchesLogin := a.Methods != nil || a.Disabled.Set || a.Providers != nil || a.Header != nil
		if touchesLogin && s.adminsLockedOut(next, st, r) {
			field := ""
			if a.Methods != nil {
				field = "auth.methods"
			}
			return &apiError{Status: http.StatusConflict, Code: "would_lock_out", Field: field,
				Message: "После этого изменения ни один администратор не сможет войти: включите способ входа, который у администратора настроен (пароль или привязанный аккаунт)"}
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}

	ip := re.rv.ClientIP(r).String()
	if cur.Methods.Value != next.Methods.Value || cur.Disabled.Value != next.Disabled.Value {
		s.log.Warn("login methods changed", "from", fmt.Sprintf("%+v", cur.Methods.Value), "to", fmt.Sprintf("%+v", next.Methods.Value),
			"disabled", next.Disabled.Value, "user", pr.name(), "ip", ip)
	}
	nre, err := s.newReqEnv()
	if err != nil {
		writeAPIError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.settingsView(r, nre))
}

// ---- provider test login ----

func (s *Server) handleProviderTest(w http.ResponseWriter, r *http.Request, re *reqEnv, id string) {
	var in putProvider
	if r.ContentLength != 0 {
		if err := decodeJSON(w, r, &in); err != nil {
			writeAPIError(w, err)
			return
		}
	}
	st := s.store.Get()
	if err := applyProvider(id, &in, re.eff.Providers[id], st.Auth.Providers.Get(id)); err != nil {
		writeAPIError(w, err)
		return
	}
	eff, err := config.Resolve(s.env, st)
	if err != nil {
		writeAPIError(w, badField("", err.Error()))
		return
	}
	p := eff.Providers[id]
	if !p.Enabled() {
		writeAPIError(w, &apiError{Status: http.StatusBadRequest, Code: "provider_incomplete", Message: "Заполните настройки провайдера (issuer, client id, secret)"})
		return
	}
	redirect := redirectURL(re.rv.Origin(r), id)
	prov, err := s.factories[id](r.Context(), p, eff, redirect)
	if err != nil {
		s.log.Warn("provider test: setup failed", "provider", id, "error", err)
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "provider_setup_failed",
			"message": "Не удалось подключиться к провайдеру: " + err.Error(),
		})
		return
	}
	tok := s.tests.add(&testFlow{provider: id, prov: prov, hash: p.Hash()})
	writeJSON(w, http.StatusOK, map[string]string{
		"url":         "/_ui/auth/" + id + "/start?test=" + url.QueryEscape(tok),
		"token":       tok,
		"redirectUrl": redirect,
	})
}

func (s *Server) handleProviderTestStatus(w http.ResponseWriter, id, tok string) {
	st, pid, ok := s.tests.status(tok)
	if !ok || pid != id {
		writeErr(w, http.StatusNotFound, "not_found", "Проверка не найдена или устарела")
		return
	}
	writeJSON(w, http.StatusOK, st)
}
