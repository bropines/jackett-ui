# jackett-ui v0.3: users, roles, login methods, API tokens

Extends `docs/server-spec.md` (v0.2). Where this document conflicts with it, this document wins. Goal: from "one admin" to a small multi-user panel. Jackett stays a private backend: **its own API key never leaves the server**; clients use per-user tokens issued by jackett-ui.

## 1. Model (settings file v2)

`DATA_DIR/jackett-ui.json` gets `"version": 2`. New/changed parts:

```json
{
  "version": 2,
  "sessionKey": "…", "authEpoch": 7,
  "auth": {
    "methods": { "password": true, "oidc": true, "google": false, "github": false, "header": false },
    "disabled": false,
    "autoProvision": { "enabled": true, "role": "viewer" },
    "allowedEmails": [], "adminEmails": [], "githubUsers": [],
    "providers": { "oidc": {…as v0.2…}, "google": {…}, "github": {…} },
    "header": { "name": "Remote-User", "trusted": [] }
  },
  "users": [
    {
      "id": "u_7f3k2…",              "username": "admin",          "name": "Админ",
      "role": "admin",               "passwordHash": "$2a$12$…",   "disabled": false,
      "identities": [ { "provider": "oidc", "issuer": "https://auth…/", "subject": "abc…", "label": "me@example.com", "linkedAt": "…" } ],
      "epoch": 1, "createdAt": "…", "lastLoginAt": "…"
    }
  ],
  "tokens": [
    { "id": "t_…", "userId": "u_…", "name": "qBittorrent", "prefix": "jui_Ab3d", "hash": "<sha256 hex>",
      "createdAt": "…", "lastUsedAt": "…", "lastUsedIp": "…", "expiresAt": null }
  ],
  "invites": [
    { "id": "i_…", "hash": "<sha256 hex>", "role": "editor", "name": "Thero", "createdBy": "u_…", "expiresAt": "…" }
  ]
}
```

- IDs: prefix + 16 random base32 chars. `username`: `[a-z0-9._-]{2,32}`, unique, case-insensitive.
- **Migration v1 → v2** (on start, file rewritten atomically, the old file kept as `jackett-ui.json.v1.bak`):
  - stored `passwordHash` → user `admin` (role admin);
  - `mode` → `methods`: `password` → {password}; `sso` → {password: passwordFallback, + every provider that has a client id}; `header` → {header}; `none` → `disabled: true`;
  - `allowedEmails` / `githubUsers` / `oidc.allowedGroups` stay (they become auto-provision rules, see 3).
- `users[].epoch`: bumped on that user's password change, role change, disable, "log out everywhere"; sessions carry `{uid, epoch}` and die when it differs. The global `authEpoch` still ends everybody's sessions.

## 2. Roles and what they can do

| Capability | viewer («Поиск») | editor («Редактор») | admin |
|---|---|---|---|
| Search, results, download `.torrent`, magnet, Torznab via token | ✓ | ✓ | ✓ |
| Read the list of configured indexers, their caps | ✓ | ✓ | ✓ |
| Own profile: name, own password, link/unlink own identities, own API tokens, log out everywhere | ✓ | ✓ | ✓ |
| Add / configure / delete / test indexers, read indexer configs | | ✓ | ✓ |
| Jackett logs and cache | | ✓ | ✓ |
| Jackett server settings (proxy, FlareSolverr, …) | | | ✓ |
| Panel settings: login methods, providers, allow-lists, public URL, session TTL | | | ✓ |
| Users: create/invite, change role, disable, delete, reset password, unlink identities, revoke anyone's tokens | | | ✓ |

### Jackett API authorization (the proxy enforces it)

Paths are matched after normalization (lower-case, collapsed slashes, no `..`):

| Method + path (`/api/v2.0/…`) | Min role |
|---|---|
| `GET indexers` (any query), `GET indexers/{id}/results`, `…/results/torznab/*`, `…/results/potato/*` | viewer |
| `GET /dl/*`, `GET /bh/*` | viewer |
| `GET indexers/{id}/config`, `POST indexers/{id}/config`, `DELETE indexers/{id}`, `POST indexers/{id}/test`, `GET indexers/cache`, `GET server/logs` | editor |
| `GET/POST server/config`, `POST server/update`, `POST server/adminpassword`, anything else | admin |

Unknown Jackett paths default to **admin**. `/UI/*` stays blocked (404) as in v0.2.

Never return Jackett's API key to non-admins: `GET server/config` is admin-only, and for admins the response's `api_key` is replaced with `"(hidden)"` too — the UI no longer needs it (section 4).

## 3. Login

### Methods
`auth.methods` toggles each method independently; login page shows a password form if `password` is on and a button per enabled+verified provider. `auth.disabled: true` = no login at all (everyone is an anonymous **admin**; explicit, red banner; requires `confirm`). At least one method must stay usable for at least one admin (server refuses changes that would lock all admins out: `would_lock_out`).

Env: `AUTH_METHODS=password,oidc,google,github,header` (comma list, locks the whole methods block). `AUTH_MODE` from v0.2 is still accepted and mapped as in the migration (log a deprecation warning). `AUTH_DISABLED=true` replaces `AUTH_MODE=none`.

### Who a login resolves to
1. **Password**: `username` + password → that user (must be enabled). Login form gets a username field (default value `admin` placeholder).
2. **External provider** (oidc/google/github): identity key = (provider, issuer, subject) — GitHub: subject = numeric user id, issuer `https://github.com`. Resolution order:
   1. an enabled user has this identity linked → that user;
   2. else, if `autoProvision.enabled` and the identity passes the allow-lists of v0.2 (`allowedEmails` [verified email, or unverified if the oidc provider allows it], `githubUsers`, `oidc.allowedGroups`) → create a user (username from email local part / login, deduplicated; name from profile; role = `admin` if the email is in `adminEmails`, else `autoProvision.role`), link the identity, log in;
   3. else → `user_not_allowed` (no account is created).
3. **Header**: header value from a trusted proxy → user whose `username` equals it (case-insensitive); if none and auto-provision is on → create with the default role; else 401.
4. **Bootstrap**: while there are **no users**, the setup wizard (password) creates the first user as admin; additionally the first external login that passes the allow-lists becomes **admin** (so an SSO-only deployment can bootstrap). Once a user exists, normal rules apply.

Env for the new knobs: `AUTH_ADMIN_EMAILS`, `AUTH_AUTO_PROVISION=true|false`, `AUTH_DEFAULT_ROLE=viewer|editor|admin`. Existing `AUTH_ALLOWED_EMAILS`, `GITHUB_USERS`, `OIDC_ALLOWED_GROUPS`, `OIDC_ALLOW_UNVERIFIED_EMAIL` keep their meaning (they gate auto-provisioning). `AUTH_PASSWORD`/`AUTH_PASSWORD_HASH` set the password of the user `admin` (created if missing, role admin), locked.

### Linking identities
- Logged-in user: `GET /_ui/auth/{provider}/start?link=1&return=/profile` → after the provider login, the identity is linked to **the current session's user** (the flow cookie carries a signed `link:<uid>` intent bound to that session; the callback re-checks the session is still the same user). If the identity is already linked to another user → `?authError=identity_in_use`. Allow-lists are NOT required for linking (the user is already authenticated); the provider must be enabled+verified.
- Unlink: `DELETE /_ui/api/me/identities/{index or key}`; refuse if it would leave the user with no way to log in (no password and no other identity while the corresponding methods are on) → `would_lock_out`.

### Invites
- Admin creates an invite: name, role, expiry (default 7 days, max 30) → response contains the **one-time URL** `PUBLIC/invite/<token>` (token shown once; stored hashed).
- `GET /_ui/api/invites/{token}` (public) → `{name, role, expiresAt, methods: [...]}` or 404/410.
- Accepting: the invitee either sets a username + password (`POST /_ui/api/invites/{token}/accept {username,password}`) if password login is on, or clicks a provider button → `GET /_ui/auth/{provider}/start?invite=<token>` → callback creates the user with the invite's role, links the identity (allow-lists not required — the invite is the permission), consumes the invite, logs in. Invites are single-use.

## 4. API tokens (Torznab / qBittorrent / *arr)

- Format: `jui_` + 32 chars base62 (190 bits). Shown **once** at creation. Stored as SHA-256 hex; lookup by hash, constant-time compare. `prefix` = first 8 chars for display.
- A token acts as its owner with the owner's role, **only on Jackett paths** (`/api/v2.0/…`, `/dl/`, `/bh/`), never on `/_ui/api` or `/_ui/auth`. Disabled owner → token rejected.
- Accepted as `apikey=<token>` query (Torznab standard), `jackett_apikey=<token>` (download links), or header `X-Api-Key`.
- **Jackett's own key is rejected** from clients (401 `invalid_token`), no switch.
- Proxying a token request: replace the token in `apikey` / `jackett_apikey` with Jackett's real key; drop `X-Api-Key`; never attach the server's Jackett session cookie to token requests.
- **Response rewriting**: for every proxied response with a text body (JSON, XML, HTML, text — not `application/x-bittorrent`), replace every occurrence of Jackett's real API key with the caller's token (token requests) or with the literal `session` (session requests). Handle gzip from Jackett (decompress, rewrite, then let our gzip middleware compress). Cap rewritten bodies at 64 MB; bigger → 502.
- Session requests (the UI): may omit `apikey` entirely; the server injects the real key where Jackett needs it (`/results`, `/dl`, `/bh`, torznab). `jackett_apikey=session` / `apikey=session` is accepted only together with a valid session cookie.
- Each use updates `lastUsedAt`/`lastUsedIp` (write-behind, at most once per minute per token).
- Users: up to 20 tokens each; name 1–64 chars; optional expiry (`expiresAt`).
- The Torznab URL shown in the UI = `<public>/api/v2.0/indexers/{id}/results/torznab/` with "API key = your token".

The frontend stops reading `api_key` from Jackett's server config; search uses the session.

## 5. HTTP API changes (`/_ui/api`)

All JSON, errors `{error, message, field?}` as in v0.2.

- `GET /auth/state` (public): `{ setupRequired, authenticated, disabled, user?: {id, username, name, role}, methods: {password: bool, providers: [{id,name}], header: bool}, jackett: {ok, version?}, version }`.
- `POST /auth/setup` `{username?, password}` → first admin. `POST /auth/login` `{username, password}`. `POST /auth/logout`. `POST /auth/logout-all` (own sessions: bumps own epoch).
- **Me**: `GET /me` → `{user, identities:[{provider, label, linkedAt}], tokens:[{id,name,prefix,createdAt,lastUsedAt,lastUsedIp,expiresAt}]}`; `PATCH /me {name?}`; `POST /me/password {current?, new}` (current required if a password is set); `DELETE /me/identities/{provider}`; `POST /me/tokens {name, expiresInDays?}` → `{token, …meta}`; `DELETE /me/tokens/{id}`.
- **Users** (admin): `GET /users` → list with `identities`, `tokenCount`, `lastLoginAt`; `POST /users {username, name, role, password?}`; `PATCH /users/{id} {name?, role?, disabled?, password?}`; `DELETE /users/{id}` (also deletes their tokens); `POST /users/{id}/logout` (bump epoch); `DELETE /users/{id}/identities/{provider}`; `GET /users/{id}/tokens`, `DELETE /tokens/{id}` (any). Refuse removing/demoting/disabling the last enabled admin (`last_admin`).
- **Invites** (admin): `GET /invites`, `POST /invites {name, role, expiresInDays}` → `{url, …}`, `DELETE /invites/{id}`. Public: `GET /invites/{token}`, `POST /invites/{token}/accept`.
- **Settings** (admin): `GET/PUT /settings` keep the v0.2 shape with: `auth.mode` → `auth.methods` (object of bools, each with locked/env), `auth.disabled`, `auth.autoProvision {enabled, role}`, `auth.adminEmails`; `passwordSet`/`passwordFallback` removed (passwords are per user now). Provider test flow unchanged.

## 6. Frontend

- **Profile page** `/profile` (everyone; user menu → «Профиль»): name; password (set/change); linked accounts (per enabled provider: «Привязать» / «Отвязать», label, date); **API tokens** (create with name + optional expiry → dialog showing the token once with copy buttons and ready strings for qBittorrent's Jackett plugin and Torznab; list with last use; revoke); «Выйти на всех устройствах».
- **Settings** `/settings` (admin only; editors/viewers don't see it in the nav) with **tabs**:
  - **Панель**: login methods (checkboxes), providers (as v0.2 card), auto-provision (switch + default role), allowed / admin e-mails, GitHub users, public URL, session TTL;
  - **Пользователи**: table/cards (name, username, role badge, identities icons, tokens count, last login, disabled), actions: change role, disable/enable, reset password, log out, delete; «Пригласить» (name, role, expiry → shows the link once, copy); pending invites list with revoke; «Создать с паролем».
  - **Jackett**: the existing Jackett server settings (moved here as-is).
- **Invite page** `/invite/:token` (public): shows name/role, password form (username + password) if available, provider buttons.
- **Login page**: username + password (when password is on), provider buttons.
- Role-aware UI: viewers don't see «Трекеры» management actions (they see the list read-only), logs nav hidden for viewers; editors don't see «Настройки». The server is the authority; the UI just hides what would be 403.
- Indexers page Torznab / qBittorrent help: point to the user's tokens (no Jackett key anywhere).
- Search uses the session (no `apikey`), download links from results already come rewritten (`jackett_apikey=session`) and work with the cookie.

## 7. Tests

Server: migration v1→v2 (all four modes); role matrix for every Jackett path class (viewer/editor/admin/token/anonymous); token create/use/revoke/expiry/disabled owner/Jackett key rejected; response rewriting (JSON, Torznab XML, gzip from upstream, key never present in any response for any role); session `apikey=session` only with cookie; linking (success, identity in use, wrong session, provider not verified); invites (password accept, provider accept, expired, reused); auto-provision rules incl. adminEmails and bootstrap-first-admin; last-admin protection; would_lock_out on methods/unlink; header mapping; per-user epoch logout. Frontend: profile tokens dialog, settings tabs by role, users actions, invite page states, login with username.

## Implemented decisions

Where this spec was silent, the server (v0.3.0) does the following.

**Migration and env**
- v1 → v2: `sso` and `header` installations get `autoProvision {enabled: true, role: admin}`, because in v0.2 everyone who got in had full control (an admin can lower it). `none` → `disabled: true` with `methods {password}`. An unknown mode becomes `{password}`. `authEpoch` is bumped and the session payload changed, so v0.2 cookies are never accepted.
- `AUTH_MODE` together with `AUTH_METHODS` or `AUTH_DISABLED` refuses to start. `AUTH_MODE=sso` turns on every *configured* provider; `AUTH_PASSWORD_FALLBACK` is still read for that mapping only. `AUTH_METHODS` naming an unconfigured provider refuses to start; a stored method of an unconfigured provider is just not offered.
- `AUTH_PASSWORD[_HASH]`: the user `admin` is created on start if missing (role admin, no stored hash). Changing, resetting or deleting it gives 409 `locked`; its role and disabled flag can still be changed.
- `AUTH_RESET` starts authentication over: all users, tokens and invites are deleted, `methods {password}`, `disabled: false`, providers and allow-lists cleared, session key rotated. Header settings, public URL and TTL are kept.

**Sessions and login**
- A session records its method (`password`, a provider id, or `setup`) and dies when that method is switched off. `setup` is used only when the wizard ran with password login off. Header logins don't issue cookies; a trusted header wins over a cookie.
- Setup accepts an optional `username` (default `admin`) and works even when password login is off.
- Password login: an empty `username` means `admin`. An unknown user and a wrong password both give 401 `invalid_credentials`. A correct password for a disabled user gives 401 `user_disabled`.
- External logins: an identity linked to a *disabled* user gives `user_disabled` (no new account). `adminEmails` also admit (an implicit allow-list) and need a verified e-mail. SSO bootstrap (no users yet) doesn't need `autoProvision.enabled`, but does need the allow-lists.
- Header: a value matches a user name, or a linked `header` identity (lower-cased value) for values that aren't valid user names (e-mails). New header users get a derived user name plus that identity. The first header login while there are no users becomes admin. `adminEmails` don't apply to headers.
- Login page providers = method on + configured + verified (no allow-list needed: linked users log in without one).
- The provider test login only proves that the IdP round trip works. It needs no allow-list and never creates a user or a session.

**Linking, invites, lock-out**
- Linking needs the provider configured and verified, but *not* its method on (link first, then switch to SSO-only). One identity per provider per user (`provider_already_linked`); linking the same identity again is a no-op. Success redirects to `return?linked=<provider>`. Errors: `unauthorized`, `provider_disabled`, `identity_in_use`, `provider_already_linked`, `wrong_session`. The intent is bound to user id + user epoch + global epoch.
- Invites: the secret is 32 base62 characters, stored as SHA-256. An invite is deleted when used, so a used invite gives 404 `invite_not_found` (there is no `invite_used`). Expired gives 410 `invite_expired`. Expiry is 1–30 days (default 7); at most 100 pending. Accepting with a provider needs that provider's method on. Failures redirect to `/invite/<token>?authError=…`, success goes to `/`. The public `methods` field has the `auth/state` shape `{password, providers:[{id,name}]}`.
- `would_lock_out` is checked on settings changes that touch methods, `disabled`, providers or header. An admin can still log in if: password login is on and they have a password (or the env one); or they have a linked identity whose provider method is on and verified; or header login is on and *this request's* trusted header maps to them. Unlinking from yourself counts header login if it is on. An admin unlinking someone else is not guarded.
- `last_admin` guards demoting, disabling and deleting the last enabled admin. `PATCH /users/{id} {password: null}` clears a password. Role, disable, password and logout changes bump the user's epoch. When you change yourself your cookie is re-issued (cleared if you disabled or deleted yourself).

**API tokens and the proxy**
- `passkey` is treated as a key parameter too (stripped or replaced). All presented key values must agree, otherwise 401 `invalid_token`. Parameter names are matched case-insensitively and URL-decoded.
- Tokens on cookie-only Jackett paths (`/indexers`, `server/*`, …) are forwarded with no cookie and no key, so Jackett answers with its own login challenge. Token expiry is 1–3650 days.
- `lastUsedAt`: kept in memory per use. The request that crosses the one-minute mark for a token writes it, and pending usage is flushed on shutdown. API views show the in-memory value.
- Session requests on key routes get the key injected (`apikey`; `jackett_apikey` for `/dl` and `/bh`) and no cookie. `apikey=session` works for any authenticated non-token caller (session, header, login disabled).
- Rewriting covers every proxied response. Headers are always scrubbed; bodies are too, except `application/x-bittorrent`, `image/*`, HEAD, 204 and 304. Upstream `Range`/`If-Range` are dropped and `Accept-Encoding: gzip` is forced. Any other content encoding gives 502. Over 64 MB gives 502 `response_too_large`. Protocol upgrades are refused.
- `server/config`: GET returns `api_key: "(hidden)"`. A POST with `api_key` set to `"(hidden)"` or `"session"` gets the real key back before it is forwarded. Any non-GET to `/api/v2.0/server/*` makes the server re-read the key, which it also does every 5 minutes. If the key can't be read, Jackett requests fail with 502 (fail closed).
- Path matrix details: under `/results` only `results`, `results/torznab[/…]` and `results/potato[/…]` are viewer paths. HEAD counts as GET. `/UI/*` other than Dashboard/Login (404) and Logout is admin.

**API shapes**
- Lists (`/users`, `/invites`, `/me/tokens`, `/users/{id}/tokens`) are bare arrays.
- `PATCH /me` and `POST /me/password` return 204. `POST /users` returns 201 with the user; `PATCH /users/{id}` returns 200 with the user. `POST /me/tokens` and `POST /invites` return 201 (the invite includes an absolute `url` and `token`).
- With login disabled, `auth/state.user` is `null`, and `/me` and the token endpoints give 409 `no_user`.
- The user view adds `passwordSet`, `passwordLocked` and `createdAt`.

### Setup wizard and SSO (fix before release)
- The password setup wizard (`setupRequired`) is open only while there are no users **and password is the only login method**. With any SSO method or header login on, the first allowed external login becomes the admin instead; `POST /auth/setup` answers 409. Otherwise an SSO-configured instance without users (e.g. right after migrating a v0.2 SSO install that never had a password) would let the first anonymous visitor create the admin.
- Migration: v0.2 `sso` keeps the password method only if a password was actually stored.
