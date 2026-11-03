package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bropines/jackett-ui/server/internal/auth"
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
		}
		providers[id] = v
	}
	return map[string]any{
		"auth": map[string]any{
			"mode":             fv(eff.Mode),
			"passwordSet":      fieldView{Value: eff.PasswordHash.Value != "", Locked: eff.PasswordHash.Locked, Env: eff.PasswordHash.Env},
			"passwordFallback": fv(eff.PasswordFallback),
			"allowedEmails":    fv(eff.AllowedEmails),
			"githubUsers":      fv(eff.GitHubUsers),
			"providers":        providers,
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
}

type putPassword struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

type putHeader struct {
	Name    opt[string]   `json:"name"`
	Trusted opt[[]string] `json:"trusted"`
}

type putAuth struct {
	Mode             opt[string]   `json:"mode"`
	PasswordFallback opt[bool]     `json:"passwordFallback"`
	AllowedEmails    opt[[]string] `json:"allowedEmails"`
	GitHubUsers      opt[[]string] `json:"githubUsers"`
	Providers        *struct {
		OIDC   *putProvider `json:"oidc"`
		Google *putProvider `json:"google"`
		GitHub *putProvider `json:"github"`
	} `json:"providers"`
	Header   *putHeader   `json:"header"`
	Password *putPassword `json:"password"`
	Confirm  bool         `json:"confirm"`
}

type putRequest struct {
	Auth       *putAuth     `json:"auth"`
	PublicURL  opt[string]  `json:"publicUrl"`
	SessionTTL opt[string]  `json:"sessionTtl"`
	Password   *putPassword `json:"password"` // alias of auth.password
	Confirm    bool         `json:"confirm"`  // alias of auth.confirm
}

func lockedErr(field, env string) error {
	msg := "Значение задано переменной окружения"
	if env != "" {
		msg += " " + env
	}
	return &apiError{Status: http.StatusConflict, Code: "locked", Message: msg, Field: field}
}

func badField(field, msg string) error {
	return &apiError{Status: http.StatusBadRequest, Code: "invalid_value", Message: msg, Field: field}
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
			"allowedGroups": in.AllowedGroups.Set, "groupsClaim": in.GroupsClaim.Set} {
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

func conflict(code, msg string) error {
	return &apiError{Status: http.StatusConflict, Code: code, Message: msg}
}

// settingsUpdate is the outcome of a PUT.
type settingsUpdate struct {
	cur, next   config.Effective
	pwChanged   bool
	modeChanged bool
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request, re *reqEnv, id auth.Identity) {
	var req putRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeAPIError(w, err)
		return
	}
	a := req.Auth
	if a == nil {
		a = &putAuth{}
	}
	pw := a.Password
	if req.Password != nil {
		if pw != nil {
			writeAPIError(w, badField("password", "Пароль передан дважды"))
			return
		}
		pw = req.Password
	}
	confirm := a.Confirm || req.Confirm

	// Hash the new password before taking the store lock (bcrypt is slow).
	var newHash string
	if pw != nil {
		if re.eff.PasswordHash.Locked {
			writeAPIError(w, lockedErr("auth.password", re.eff.PasswordHash.Env))
			return
		}
		if re.eff.PasswordHash.Value != "" {
			if !s.rateLimit(w, r, re) {
				return
			}
			if !auth.CheckPassword(re.eff.PasswordHash.Value, pw.Current) {
				s.limiter.Failure(re.rv.ClientIP(r))
				s.log.Warn("password change: wrong current password", "user", id.User, "ip", re.rv.ClientIP(r).String())
				writeAPIError(w, &apiError{Status: http.StatusForbidden, Code: "invalid_credentials", Message: "Текущий пароль неверен", Field: "password.current"})
				return
			}
			s.limiter.Success(re.rv.ClientIP(r))
		}
		h, err := auth.HashPassword(pw.New)
		if err != nil {
			perr := passwordAPIError(err)
			var ae *apiError
			if errors.As(perr, &ae) {
				ae.Field = "password.new"
			}
			writeAPIError(w, perr)
			return
		}
		newHash = h
	}

	var up settingsUpdate
	err := s.store.Update(func(st *store.Settings) error {
		cur, err := config.Resolve(s.env, *st)
		if err != nil {
			return err
		}
		up.cur = cur
		if pw != nil && cur.PasswordHash.Value != re.eff.PasswordHash.Value {
			return conflict("conflict", "Пароль изменился, повторите попытку")
		}

		// Mode.
		newMode := cur.Mode.Value
		if a.Mode.Set {
			m := ""
			if !a.Mode.Null {
				m = config.NormalizeMode(a.Mode.V)
			}
			if !auth.ValidMode(m) {
				return badField("auth.mode", "Неизвестный режим входа")
			}
			if cur.Mode.Locked && m != cur.Mode.Value {
				return lockedErr("auth.mode", cur.Mode.Env)
			}
			newMode = m
		}
		if a.PasswordFallback.Set {
			if cur.PasswordFallback.Locked {
				if a.PasswordFallback.Null || a.PasswordFallback.V != cur.PasswordFallback.Value {
					return lockedErr("auth.passwordFallback", cur.PasswordFallback.Env)
				}
			} else if a.PasswordFallback.Null {
				st.Auth.PasswordFallback = nil
			} else {
				v := a.PasswordFallback.V
				st.Auth.PasswordFallback = &v
			}
		}
		if err := applyList("auth.allowedEmails", a.AllowedEmails, cur.AllowedEmails, &st.Auth.AllowedEmails, nil); err != nil {
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
		if newHash != "" {
			st.Auth.PasswordHash = newHash
			up.pwChanged = true
		}
		if !cur.Mode.Locked {
			st.Auth.Mode = newMode
		}

		next, err := config.Resolve(s.env, *st)
		if err != nil {
			return badField("", err.Error())
		}
		up.next = next
		up.modeChanged = next.Mode.Value != cur.Mode.Value

		// Mode rules.
		if up.modeChanged {
			switch next.Mode.Value {
			case auth.ModeNone:
				if !confirm {
					return &apiError{Status: http.StatusBadRequest, Code: "confirm_required", Message: "Режим без входа нужно подтвердить (confirm: true)", Field: "auth.mode"}
				}
			case auth.ModeHeader:
				if len(next.HeaderPrefixes) == 0 {
					return &apiError{Status: http.StatusBadRequest, Code: "header_trusted_required", Message: "Укажите доверенные адреса прокси", Field: "auth.header.trusted"}
				}
			case auth.ModePassword:
				if next.PasswordHash.Value == "" {
					return &apiError{Status: http.StatusBadRequest, Code: "password_required", Message: "Сначала задайте пароль", Field: "password"}
				}
			case auth.ModeSSO:
				verified := false
				for _, p := range next.EnabledProviders() {
					verified = verified || p.Verified()
				}
				if !verified {
					return conflict("sso_not_ready", "Сначала настройте и проверьте вход хотя бы через одного провайдера")
				}
				if len(next.LoginProviders()) == 0 {
					return conflict(errNoAllowList.Error(), "Задайте список разрешённых пользователей (e-mail, логины GitHub или группы)")
				}
			}
		}
		// Changing providers / allow-lists in sso mode must leave a way in.
		if next.Mode.Value == auth.ModeSSO && !up.modeChanged && len(cur.LoginProviders()) > 0 &&
			len(next.LoginProviders()) == 0 && !next.PasswordLogin() {
			return conflict("would_lock_out", "После этого изменения никто не сможет войти: проверьте провайдера или включите вход по паролю")
		}
		// The caller must keep access in header mode.
		if next.Mode.Value == auth.ModeHeader && (up.modeChanged || a.Header != nil) {
			h := auth.Header{Name: next.HeaderName.Value, Trusted: next.HeaderPrefixes}
			if _, ok := h.User(r); !ok {
				return conflict("header_lockout", "Ваш запрос пришёл не через доверенный прокси с заголовком "+next.HeaderName.Value+": после переключения вы потеряете доступ")
			}
		}
		if up.modeChanged || up.pwChanged {
			st.AuthEpoch++
			up.next.Epoch = st.AuthEpoch
		}
		return nil
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}

	ip := re.rv.ClientIP(r).String()
	if up.modeChanged {
		s.log.Warn("auth mode changed", "from", up.cur.Mode.Value, "to", up.next.Mode.Value, "user", id.User, "ip", ip)
	}
	if up.pwChanged {
		s.log.Warn("admin password changed", "user", id.User, "ip", ip)
	}
	nre := &reqEnv{eff: up.next, rv: s.resolver(up.next)}
	if up.modeChanged || up.pwChanged {
		switch m := up.next.Mode.Value; m {
		case auth.ModePassword, auth.ModeSSO:
			user := id.User
			if m == auth.ModePassword {
				user = auth.AdminUser
			}
			s.issueSession(w, r, nre, user, m, up.next.Epoch)
		default:
			s.clearSession(w, r, nre)
		}
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
	if !eff.ProviderCanAllow(id) {
		writeAPIError(w, conflict(errNoAllowList.Error(), "Сначала задайте список разрешённых пользователей (e-mail, логины GitHub или группы)"))
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
