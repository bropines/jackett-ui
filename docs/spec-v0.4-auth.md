# jackett-ui v0.4: own account on first login, e-mail, passkeys

Builds on `spec-v0.3-users.md`. Everything not mentioned here stays as in v0.3.

## Goals
1. Nobody has to stay `admin`. On the first login with the env password (`AUTH_PASSWORD[_HASH]`) the UI asks the user to make their own account: either **replace** the initial `admin` or **add** a new admin next to it. Same wizard after `POST /auth/setup`.
2. Login methods are set up in that wizard, right away: password, passkey, Google / GitHub / OIDC (configure, test, link).
3. Users get an optional e-mail.
4. Passkeys (WebAuthn) as a login method.
5. A recovery command, `jackett-ui reset-password <user>`, so the env password is not the only way back in.

## 1. Settings file v3
`version: 3`. A v2 file is migrated on Open: the original is kept as `jackett-ui.json.v2.bak`, `auth.methods.passkey` becomes `true`, nothing else changes. Older builds refuse a v3 file (they already refuse newer versions).

New fields:
- `onboarded` (settings, bool): the first-login wizard was finished or skipped. Set by `POST /auth/setup` and by `POST /onboarding`. `AUTH_RESET` clears it.
- `users[].email` (string, optional): lower-cased and trimmed, at most 254 characters, must contain `@` and no spaces. Unique among users (case-insensitive) when not empty.
- `users[].bootstrap` (bool): this user's password comes from `AUTH_PASSWORD[_HASH]`. At most one user has it. **Replaces the old "user named admin" rule everywhere**: the env password, `passwordLocked`, the `locked` errors on password changes and `canLogIn` all look at `bootstrap`, not at the name.
- `users[].webauthnId` (bytes): random 32-byte WebAuthn user handle, created with the first passkey.
- `users[].passkeys[]`: `{id ("pk_…"), name, credentialId, publicKey, aaguid, signCount, transports[], attachment, backupEligible, backupState, cloneWarning, createdAt, lastUsedAt}`.
- `auth.methods.passkey` (bool). `AUTH_METHODS` accepts `passkey`. Fresh installs: `{password: true, passkey: true}`.

### The env password (start-up, replaces `ensureEnvAdmin`)
With `AUTH_PASSWORD[_HASH]` set:
- some user has `bootstrap` → nothing to do;
- else, not `onboarded` → the user `admin` gets `bootstrap: true` (created first if missing, role admin, no stored hash);
- else (onboarded and no bootstrap user: it was replaced or deleted) → the env password is **ignored**, with a start-up warning: `AUTH_PASSWORD is set but ignored: the initial admin was replaced. Remove it from the environment; use "jackett-ui reset-password <user>" to recover access.`

So the env password is a first-login credential. After "replace" it stops working; after "add" it keeps working for `admin` until that user is deleted.

## 2. First-login wizard

### When
`GET /auth/state` gets `"onboarding": true` when the caller is logged in as the `bootstrap` user, `onboarded` is false and login isn't disabled. Any login method counts, including an identity linked to `admin`. While it is true the UI shows the wizard instead of the app (the server does not block other routes).

### `POST /_ui/api/onboarding` (protected; 409 `not_onboarding` unless `onboarding` is true for the caller)
```json
{ "mode": "replace" | "add" | "skip", "username": "bropines", "name": "Bropines", "email": "me@example.com", "password": "…" }
```
- `replace`: the caller (the bootstrap user) is renamed to `username` and gets `name`, `email`, a password hash and `bootstrap: false`. Its epoch is bumped and the caller's cookie is re-issued. Identities, tokens and role stay.
- `add`: a new admin `{username, name, email, password}` is created; the caller is logged in as that user (new cookie, method `password`). `admin` stays the bootstrap user.
- `skip`: nothing but `onboarded: true`.
- In every mode `onboarded` becomes true. `username` follows the usual rules (`username_taken`, `invalid_username`). The password is required for `replace` and `add` (min 8). `email` is optional.
- Response 204.

### `POST /auth/setup`
The body gets optional `name` and `email`: `{username, name, email, password}`. It sets `onboarded: true`.

### After the account step
The UI opens `/welcome?step=methods`, a page that is reachable any time:
- **Пароль**: shows that it is set.
- **Passkey**: "Добавить passkey" (the registration ceremony from §4). If passkeys aren't available, shows why.
- **Google / GitHub / OIDC**: each card shows configured, verified and on. "Настроить" opens the provider form (the same fields as in settings: redirect URL to copy, client id/secret, test login). Once the provider is verified: "Включить вход" switches the method on, and "Привязать к моему аккаунту" runs the link flow with `return=/welcome?step=methods`.
- "Готово" → `/`.

All of this uses existing endpoints (`PUT /settings`, `POST /settings/providers/{id}/test`, `/_ui/auth/{id}/start?link=1`) plus §4. Provider cards are shown to admins only.

## 3. E-mail
- `PATCH /me` accepts `email` (`""` clears it). `POST /users` and `PATCH /users/{id}` accept `email` (admin).
- Errors: 400 `invalid_email`, 409 `email_taken` (field `email`).
- The user view gets `email`, `bootstrap` and `passkeyCount`. `auth/state.user` gets `email`.
- The e-mail is informational in v0.4. It is **not** used to match external logins.

## 4. Passkeys
Library: `github.com/go-webauthn/webauthn`. Discoverable credentials (resident key required), user verification required, usernameless login.

**Relying party.** RP ID = host name of the effective public URL (`PUBLIC_URL`, or derived per request like the OIDC redirect URL). Origin = that URL's origin. Passkeys are **available** when the scheme is https, or the host is `localhost` / `*.localhost`. They are unavailable for an IP address or plain http, with the reason `Passkey работает только по https-адресу с доменным именем (PUBLIC_URL)`.

**Ceremonies.** State lives in memory: id = 32 random bytes in base64url, single use, 5-minute TTL. At most 500 pending login ceremonies; above that, 429 `rate_limited`. A registration ceremony is bound to the user id and that user's epoch.

**Endpoints** (JSON; `publicKey` is the WebAuthn options object in its JSON form, binary fields base64url, exactly what `PublicKeyCredential.parse*OptionsFromJSON` accepts; `credential` is `PublicKeyCredential.toJSON()`):
- `POST /_ui/api/auth/passkey/begin` (public, rate-limited, CSRF) → `{ "ceremony": "…", "publicKey": {…} }`. 403 `passkey_login_disabled` when the method is off or passkeys are unavailable.
- `POST /_ui/api/auth/passkey/finish` (public) `{ceremony, credential}` → 204 + session (method `passkey`). Failures: 401 `passkey_invalid` (unknown credential, bad signature, expired ceremony), 401 `user_disabled`. A sign counter that doesn't advance sets `cloneWarning` and refuses the login.
- `GET /_ui/api/me/passkeys` → `[{id, name, createdAt, lastUsedAt, synced, cloneWarning}]` (`synced` = backupState).
- `POST /_ui/api/me/passkeys/begin` → `{ceremony, publicKey}` (excludes the user's existing credentials). 409 `passkeys_unavailable` with the reason as message. Needs a session user, not header login.
- `POST /_ui/api/me/passkeys/finish` `{ceremony, name, credential}` → 201 passkey view. `name` is 1–64 characters; empty means "Passkey". At most 20 per user.
- `PATCH /_ui/api/me/passkeys/{id}` `{name}` → 200 view. `DELETE /_ui/api/me/passkeys/{id}` → 204, or 409 `would_lock_out` if it was the last way in.
- `DELETE /_ui/api/users/{id}/passkeys/{pid}` (admin) → 204.

**State and settings.**
- `auth/state.methods.passkey` is true when the method is on, passkeys are available for this request and at least one enabled user has a passkey.
- `GET /settings` adds `auth.methods.passkey` (field view) and `auth.passkey: { available, rpId, reason }`.
- Switching the method on doesn't need `available` (it is just not offered then).

**Lock-out.** `canLogIn` also counts "the passkey method is on and the user has a passkey". A session with method `passkey` dies when the method is switched off, like other methods.

## 5. Recovery CLI
`jackett-ui reset-password <username> [--enable-password-login]`
- Reads the new password from stdin: the first line, or two prompts when stdin is a terminal.
- Sets the hash, clears `bootstrap`, enables the user, bumps its epoch.
- With the flag, also switches the password method on (refused if `AUTH_METHODS` locks it).
- Prints what it did and exits.
- It writes `DATA_DIR/jackett-ui.json` through the store. A running server notices the file change (the store re-reads the file when its mtime/size changed, checked at most once per second on `Get`), so no restart is needed.

Usage: `docker exec <container> jackett-ui reset-password admin` / `kubectl exec deploy/jackett -c ui -- jackett-ui reset-password admin`.

## 6. Frontend
- **AuthGate**: `onboarding` → the wizard's account step (full screen, like setup). The mode is chosen first ("Заменить admin" / "Добавить ещё одного администратора"), then login, name, e-mail (optional) and password with confirmation. "Пропустить" is a small link.
- **Setup page**: adds name and e-mail; on success goes to `/welcome?step=methods`.
- **Login page**: a "Войти с passkey" button when `methods.passkey`.
- **Profile**: e-mail in the account card (editable); a new "Passkeys" card (list with name, created, last used, "синхронизирован" badge, rename, delete, "Добавить passkey"). If unavailable, it explains why.
- **Users tab**: e-mail shown under the name; passkey count; e-mail in the create/edit dialogs; the bootstrap user is marked "из AUTH_PASSWORD".
- **Settings → Способы входа**: a Passkey switch with the availability reason.
- `src/lib/webauthn.ts`: base64url ↔ ArrayBuffer helpers and `createPasskey(publicKey)` / `getPasskey(publicKey)`. Use the native `parse*OptionsFromJSON` when present, otherwise convert by hand. No npm dependency.
