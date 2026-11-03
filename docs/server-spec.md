# jackett-ui server: specification

The UI container used to be nginx + static files. It becomes a small Go server (`server/`) that:

1. serves the built UI (embedded with `go:embed`, or `STATIC_DIR` for development),
2. reverse-proxies the Jackett API to `JACKETT_URL` and logs in to Jackett **itself** (server-side cookie jar), so the browser never needs a Jackett session,
3. puts its own authentication in front of everything (password, OIDC, trusted header, or none),
4. stores its settings in a JSON file and exposes them to the UI; environment variables override the file and are shown as locked in the UI.

Goals: one container, secure by default, as easy as "run it and set a password" for home labs, and SSO for people who have an IdP (Authentik, Keycloak, Authelia, Pocket ID, Google…). Small footprint (target < 15 MB RSS idle).

## Layout

```
server/
  go.mod                      module github.com/bropines/jackett-ui/server, go 1.27
  main.go                     wiring, graceful shutdown
  internal/config/            env parsing + validation (Env struct), merge with stored settings (Effective)
  internal/store/             settings file (DATA_DIR/jackett-ui.json): load/save atomically, 0600
  internal/session/           signed cookie sessions (HMAC-SHA256), epoch-based invalidation
  internal/auth/              Authenticator interface, password (bcrypt), header, none; rate limiter
  internal/auth/oidc/         OIDC (go-oidc v3 + x/oauth2), PKCE, state/nonce, allow-lists, test flow
  internal/jackett/           Jackett client: login with admin password, cookie jar, re-login on 401
  internal/proxy/             reverse proxy for Jackett paths, header hygiene
  internal/httpapi/           /_ui/api/* handlers, middleware (auth, CSRF, security headers, gzip), static
  web/                        embed target: the built UI (copied from ../dist at build time); a placeholder index.html is committed
```

Dependencies: standard library, `golang.org/x/crypto/bcrypt`, `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2`. Nothing else without a reason.

## Environment variables

All optional. Env always wins over the settings file. A setting that comes from env is reported as `locked: true` and cannot be changed through the API.

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN` | `:8080` | listen address |
| `JACKETT_URL` | `http://127.0.0.1:9117` | Jackett base URL |
| `JACKETT_PASSWORD` | empty | Jackett admin password, if one is set in Jackett |
| `DATA_DIR` | `/config` | where `jackett-ui.json` lives (the aio image shares Jackett's `/config`) |
| `PUBLIC_URL` | empty | external URL, e.g. `https://jackett.example.com`. Used for the OIDC redirect URL and to decide `Secure` cookies. If empty: derived per request from Host / X-Forwarded-* (only from trusted proxies) |
| `TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | CIDRs whose `X-Forwarded-For/-Proto/-Host` are trusted (also used for client IP in rate limiting) |
| `AUTH_MODE` | empty = from settings, `password` if never configured | `password`, `oidc`, `header`, `none` |
| `AUTH_PASSWORD` | empty | plain admin password (hashed in memory at start; never written to disk) |
| `AUTH_PASSWORD_HASH` | empty | bcrypt hash, alternative to `AUTH_PASSWORD` |
| `AUTH_PASSWORD_FALLBACK` | from settings, default `true` | in `oidc` mode, also allow the password login |
| `OIDC_ISSUER` | | issuer URL (discovery) |
| `OIDC_CLIENT_ID` | | |
| `OIDC_CLIENT_SECRET` | | |
| `OIDC_PROVIDER_NAME` | `SSO` | button label ("Войти через Authentik") |
| `OIDC_SCOPES` | `openid email profile` | space separated |
| `OIDC_ALLOWED_EMAILS` | empty | comma separated; empty = any authenticated user of the IdP |
| `OIDC_ALLOWED_GROUPS` | empty | comma separated; checked against `OIDC_GROUPS_CLAIM` |
| `OIDC_GROUPS_CLAIM` | `groups` | |
| `AUTH_HEADER_NAME` | `Remote-User` | header mode: header with the user name/email |
| `AUTH_HEADER_TRUSTED` | empty (required for header mode) | CIDRs allowed to send that header |
| `SESSION_TTL` | `168h` | session lifetime |
| `AUTH_RESET` | empty | `1`: on start, remove the stored password/OIDC settings and rotate the session key → setup wizard again. Logs a loud warning. Jackett data is untouched |
| `STATIC_DIR` | empty | serve the UI from this directory instead of the embedded files (dev) |
| `LOG_LEVEL` | `info` | |

Invalid values → the server refuses to start with a clear message (like `AUTH_MODE=header` without `AUTH_HEADER_TRUSTED`).

## Settings file

`DATA_DIR/jackett-ui.json`, mode 0600, written atomically (temp file + rename). Shape:

```json
{
  "version": 1,
  "sessionKey": "<base64 32 bytes>",
  "authEpoch": 3,
  "auth": {
    "mode": "password",
    "passwordHash": "$2a$12$...",
    "passwordFallback": true,
    "oidc": { "issuer": "", "clientId": "", "clientSecret": "", "providerName": "", "scopes": "", "allowedEmails": [], "allowedGroups": [], "groupsClaim": "", "verified": false },
    "header": { "name": "", "trusted": [] }
  }
}
```

`sessionKey` is generated on first start. `authEpoch` increments on password change, mode change, logout-all and `AUTH_RESET`; sessions carry the epoch and are rejected when it differs.

## Authentication model

- **Setup state**: mode `password` and no password (neither stored nor via env) → `setupRequired: true`. In this state every protected route answers 401 with `{"error":"setup_required"}`; only `/_ui/api/auth/state`, `/_ui/api/auth/setup` and static files work. Jackett is NOT reachable until setup is done. This is the "secure by default" rule.
- **none**: no checks. Allowed only if set explicitly (env or the settings API with `confirm: true`). The UI shows a red banner when mode is `none`.
- **password**: single admin account (user name `admin`). bcrypt cost 12. Min length 8.
- **oidc**: authorization code flow + PKCE (S256), `state` and `nonce` in a short-lived signed cookie (10 min), ID token verified by go-oidc, email/group allow-lists enforced. Session user = email (or `preferred_username`, or `sub`). Optional password fallback.
- **header**: if the request comes from `AUTH_HEADER_TRUSTED` and has a non-empty `AUTH_HEADER_NAME`, the user is that value. Otherwise 401. No session cookie needed (but issuing one is fine).

Sessions: cookie `jui_session`, value `base64(payload).base64(hmac)`, payload `{u: user, m: mode, e: epoch, x: expiry unix}`. `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the effective scheme is https. Sliding renewal when more than half of the TTL passed.

Rate limit on `POST /_ui/api/auth/login` and `/setup`: per client IP, 5 attempts per minute burst 5, plus exponential backoff after 10 consecutive failures; answer 429 with `Retry-After`. Failed logins are logged with IP (no password).

### Public (no session) routes

- Static files (`/`, `/assets/*`, `/favicon.svg`, any SPA route → index.html). The SPA must be able to render the login page. Static files contain no secrets.
- `/healthz` → `ok`.
- `/_ui/api/auth/state`, `/_ui/api/auth/login`, `/_ui/api/auth/setup`, `/_ui/auth/oidc/start`, `/_ui/auth/oidc/callback`.
- **Jackett API-key routes** (Jackett validates the key itself; this is how qBittorrent's search plugin, *arr apps and Torznab clients work):
  - `GET /api/v2.0/indexers/{id}/results` and everything below `/api/v2.0/indexers/{id}/results/` (torznab, potato)
  - `/dl/*`, `/bh/*`
  These are proxied without a session, but only if the request carries `apikey` / `jackett_apikey` query parameters (otherwise 401 from us, so we never hand Jackett's own session to an anonymous request). The proxy must NOT attach the server-side Jackett cookie to these requests.

### Protected routes

Everything else under `/api/`, `/UI/` and `/_ui/api/*` requires a session (or header auth / none).

CSRF: all non-GET requests to `/_ui/api/*` and proxied Jackett routes must carry `X-Requested-With: XMLHttpRequest` **or** `Content-Type: application/json`, and if an `Origin` header is present it must match the effective origin. Otherwise 403.

## Jackett proxy

- Proxied prefixes: `/api/`, `/dl/`, `/bh/`, `/UI/` (Jackett login/logout pages are not needed anymore: `/UI/Dashboard` and `/UI/Login` answer 404 from us so the old UI flow can't be used to bypass; `/UI/Logout` → our logout).
- For authenticated requests the server attaches its own Jackett cookie. It logs in on start and on any 401/302-to-login from Jackett (POST `/UI/Dashboard` form `password=<JACKETT_PASSWORD>`, redirect not followed, keep `Jackett` cookie), then retries once. Concurrent re-logins are coalesced.
- Strip the browser's `Cookie` header before proxying (Jackett must only see our cookie) and drop `Set-Cookie` from Jackett responses.
- Set `X-Forwarded-Proto/Host/For` towards Jackett from the effective values.
- Timeouts: 180 s read for `/results` (searches across many trackers), 60 s otherwise.
- If Jackett is unreachable: 502 JSON `{"error":"jackett_unreachable"}`.
- If `JACKETT_PASSWORD` is wrong: `/_ui/api/auth/state` reports `jackett: {ok:false, error:"jackett_login_failed"}` and proxied calls answer 502 `{"error":"jackett_login_failed"}`.

## /_ui/api contract

All JSON. Errors: HTTP status + `{"error": "<code>", "message": "<human text, Russian>"}`.

`GET /_ui/api/auth/state` (public)
```json
{
  "mode": "password",
  "setupRequired": false,
  "authenticated": true,
  "user": "admin",
  "passwordLogin": true,
  "oidc": { "enabled": false, "providerName": "Authentik" },
  "jackett": { "ok": true, "version": "v0.24.3003" },
  "version": "0.2.0"
}
```

`POST /_ui/api/auth/setup` (public, only when setupRequired) `{ "password": "..." }` → 204 + session cookie. 409 if not in setup state.

`POST /_ui/api/auth/login` (public) `{ "password": "..." }` → 204 + cookie; 401 `invalid_credentials`; 429 `rate_limited`.

`POST /_ui/api/auth/logout` → 204, clears cookie. `POST /_ui/api/auth/logout-all` → 204, bumps `authEpoch`.

`GET /_ui/auth/oidc/start?return=/path` → 302 to the IdP. `?test=1` = test flow (see below).

`GET /_ui/auth/oidc/callback` → on success sets the session and 302 to `return` (only same-origin relative paths). On error 302 to `/?authError=<code>`.

`GET /_ui/api/settings` (protected)
```json
{
  "auth": {
    "mode":             { "value": "oidc", "locked": false },
    "passwordSet":      { "value": true,  "locked": false },
    "passwordFallback": { "value": true,  "locked": false },
    "oidc": {
      "issuer":        { "value": "https://auth.example.com/application/o/jackett/", "locked": true },
      "clientId":      { "value": "abc", "locked": true },
      "clientSecretSet": { "value": true, "locked": true },
      "providerName":  { "value": "Authentik", "locked": false },
      "scopes":        { "value": "openid email profile", "locked": false },
      "allowedEmails": { "value": ["me@example.com"], "locked": false },
      "allowedGroups": { "value": [], "locked": false },
      "groupsClaim":   { "value": "groups", "locked": false },
      "redirectUrl":   "https://jackett.example.com/_ui/auth/oidc/callback",
      "verified":      true
    },
    "header": {
      "name":    { "value": "Remote-User", "locked": false },
      "trusted": { "value": ["172.16.0.0/12"], "locked": false }
    }
  },
  "publicUrl": { "value": "", "locked": false },
  "sessionTtl": { "value": "168h", "locked": true }
}
```
Secrets are never returned (only `...Set: true`).

`PUT /_ui/api/settings` (protected) — partial update with the same shape but plain values (`"mode": "oidc"`, `"oidc": {"clientSecret": "..."}`); omitted = unchanged; empty string for a secret = unchanged, `null` = clear. Writing a locked field → 409 `locked` with the field path. Rules:
- switching to `oidc` requires `verified: true` for the current OIDC settings (any change to issuer/clientId/clientSecret/scopes resets `verified`);
- switching to `none` requires `"confirm": true`;
- switching to `header` requires non-empty trusted CIDRs;
- changing the password: `{ "password": { "current": "...", "new": "..." } }` (current required unless setup); bumps `authEpoch` and re-issues the caller's cookie.
- the caller must keep access: switching modes re-issues the caller's session for the new mode; switching to `password` requires a password to be set.

`POST /_ui/api/settings/oidc/test` (protected) `{ ...oidc fields to test... }` → validates the issuer (discovery) and returns `{ "url": "/_ui/auth/oidc/start?test=<token>" }`. The UI opens that URL in a popup/new tab; after a successful login at the IdP the callback marks these exact settings as verified (stores a hash of them), shows a small "Проверка пройдена, можно закрыть вкладку" page and does NOT change the current session. The settings page polls `GET /_ui/api/settings` (or the test endpoint returns the result on a follow-up `GET /_ui/api/settings/oidc/test/<token>`), then the user can switch the mode.

## Security headers

All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`. HTML: `Content-Security-Policy: default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' <OIDC issuer origin>`. Static assets under `/assets/` get `Cache-Control: public, max-age=31536000, immutable`, `index.html` gets `no-cache`. gzip for text types (json, js, css, svg, html) when the client accepts it and the body is > 1 KB (Jackett's already-compressed responses pass through).

## Logging

Structured `slog` text logs: start-up summary (mode, Jackett URL, data dir, which settings come from env — never values of secrets), auth events (login ok/fail with IP, logout, mode change, AUTH_RESET), Jackett login failures. No request logging by default (`LOG_LEVEL=debug` enables it).

## Frontend changes (TypeScript)

- `AuthGate` asks `/_ui/api/auth/state` first: `setupRequired` → setup wizard (set password, short explanation); not authenticated → login page (password form if `passwordLogin`, "Войти через <providerName>" button if OIDC enabled, `authError` from the URL shown); else the app. The old Jackett cookie login (`POST /UI/Dashboard`) goes away from the normal path.
- Header: user menu (user name, mode, "Выйти", "Выйти на всех устройствах").
- Settings page: new card "Вход и безопасность": mode selector, password change, OIDC fields (+ redirect URL to copy into the IdP, "Проверить вход" button, verified badge), header-mode fields, red warning for `none`, locked fields disabled with "задано переменной окружения NAME".
- API errors `setup_required` / 401 from any call → re-check `/auth/state` and show the gate.

## Tests

- Go: table tests for config parsing/validation; store round-trip/atomicity; session sign/verify/expiry/epoch; password + rate limiter; header mode trust; OIDC with an in-process fake IdP (httptest server with discovery, JWKS, token endpoint; RS256 keys generated in the test) covering success, wrong state, wrong nonce, disallowed email/group, test flow; proxy with a fake Jackett (login cookie, 401 → re-login → retry, API-key routes pass without session and without our cookie, Cookie/Set-Cookie stripping); CSRF; public/protected routing matrix; setup gating.
- Integration (manual script): real Jackett Linux binary in WSL + the server + curl.
- Frontend: vitest for the gate states and the settings form mapping.
