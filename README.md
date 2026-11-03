# jackett-ui

A modern web UI for [Jackett](https://github.com/Jackett/Jackett) with built-in login, built with React, [shadcn/ui](https://ui.shadcn.com) and a small Go server.

It is a **separate frontend**, not a fork: it talks to the stock Jackett API, so Jackett keeps getting its (almost daily) tracker fixes from upstream.

- Fast search across all trackers: filters by tracker and category, sorting, magnet / .torrent / tracker page, shareable search URLs
- Tracker catalog (~650 trackers) with search and filters by type, language and category
- Tracker settings for every tracker type (captcha, tags, checkbox groups…), test one / all trackers, Torznab links
- Server settings (proxy, FlareSolverr, cache…), logs
- **Login built in**: a password, or SSO with your own identity provider (any OpenID Connect provider: Authentik, Keycloak, Authelia, Pocket ID…), Google and GitHub, or a trusted header from your reverse proxy
- Dark mode, works on phones. ~12 MB of memory for the UI server

UI language: Russian (for now).

## How it fits together

```
browser / qBittorrent / Sonarr ──► jackett-ui (Go, :8080) ──► Jackett (:9117, not exposed)
                                    • the web UI
                                    • login (password / SSO / header)
                                    • proxies the Jackett API, logs in to Jackett itself
                                    • API-key URLs (Torznab, downloads) pass through for clients
```

**Secure by default:** until you create an admin password (the UI asks on first visit), Jackett is not reachable through the UI server at all.

## Run

### All-in-one (simplest)

One container: the stock [linuxserver.io Jackett](https://docs.linuxserver.io/images/docker-jackett) image plus jackett-ui on port 8080. Same `/config`, `PUID`, `PGID` and `TZ` as the linuxserver image, so an existing install switches by changing the image name.

```yaml
services:
  jackett:
    image: ghcr.io/bropines/jackett-ui:aio
    environment:
      PUID: "1000"
      PGID: "1000"
      TZ: Europe/Moscow
    volumes:
      - ./config:/config
    ports:
      - "8080:8080"
    restart: unless-stopped
```

Open http://localhost:8080 and set the admin password. The image is rebuilt daily when a new Jackett comes out: `:aio` is always the newest, `:aio-v0.24.3003-ls25` pins one Jackett build. With [Watchtower](https://containrrr.dev/watchtower/) it updates itself.

More ready-made setups in [`examples/`](examples/):

| File | |
|---|---|
| [`aio.yml`](examples/aio.yml) | the setup above |
| [`aio-sso.yml`](examples/aio-sso.yml) + [`.env.example`](examples/.env.example) | login with your IdP, Google and/or GitHub |
| [`existing-jackett.yml`](examples/existing-jackett.yml) | only the UI, next to a Jackett you already run |
| [`build-from-source.yml`](examples/build-from-source.yml) | build the image yourself from this repo and the newest Jackett |

### Kubernetes (Helm)

`charts/jackett` runs Jackett and the UI server in one pod with a volume for `/config`; the Service exposes only the UI.

```
helm install jackett oci://ghcr.io/bropines/charts/jackett --version 0.2.0 \
  --set persistence.storageClassName=longhorn \
  --set ingress.enabled=true --set ingress.className=traefik --set ingress.host=jackett.example.com
```

Login settings go into `ui.env` (plain values) and `ui.existingSecret` (a Secret with `OIDC_CLIENT_SECRET`, `AUTH_PASSWORD`, …). Jackett's own settings (proxy, FlareSolverr, base URL, a fixed API key) can be seeded from `jackett.settings` — see [`values.yaml`](charts/jackett/values.yaml).

## Login

Pick the mode in **Settings → Вход и безопасность**, or with `AUTH_MODE`.

| Mode | What it does |
|---|---|
| `password` (default) | one admin account; the password is set in the first-run wizard or with `AUTH_PASSWORD` |
| `sso` | buttons for the configured providers; the password can stay as a fallback |
| `header` | your reverse proxy authenticates (Authelia, Authentik outpost, …) and passes the user in a header; trusted only from the given addresses |
| `none` | no login (explicit only; the UI shows a red warning) |

**SSO providers** — each one is enabled when its client id is set, and shows as its own button:

| Provider | Variables | Redirect URL to register |
|---|---|---|
| Any OpenID Connect | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_PROVIDER_NAME` | `<PUBLIC_URL>/_ui/auth/oidc/callback` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `<PUBLIC_URL>/_ui/auth/google/callback` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `<PUBLIC_URL>/_ui/auth/github/callback` |

**Who may log in** with SSO: `AUTH_ALLOWED_EMAILS` (verified e-mails, any provider), `GITHUB_USERS` (GitHub logins), `OIDC_ALLOWED_GROUPS`. If none is set, external logins are refused — otherwise anyone with a Google or GitHub account could get in.

When you set up a provider in the UI, "Проверить вход" runs a test login first; SSO can only be switched on with a provider that passed it, so you can't lock yourself out. If you do: start once with `AUTH_RESET=1` (it resets the login settings, not Jackett), set a new password, remove the variable.

Clients that use the Jackett API key (qBittorrent's search plugin, Sonarr/Radarr, Torznab feeds, `.torrent` download links) keep working without a login: those URLs carry the key and Jackett checks it.

## Configuration

Everything is optional. Environment variables win over the settings made in the UI and show as locked there.

| Variable | Default | |
|---|---|---|
| `LISTEN` | `:8080` | listen address |
| `JACKETT_URL` | `http://127.0.0.1:9117` (aio), `http://jackett:9117` (UI image) | where Jackett is |
| `JACKETT_PASSWORD` | | Jackett's admin password, only if you set one in Jackett |
| `DATA_DIR` | `/config` (aio), `/data` (UI image) | settings file `jackett-ui.json` |
| `PUBLIC_URL` | from the request | external URL, e.g. `https://jackett.example.com` (redirect URLs, secure cookies) |
| `TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | reverse proxies whose `X-Forwarded-*` headers are trusted |
| `AUTH_MODE` | `password` | `password`, `sso`, `header`, `none` |
| `AUTH_PASSWORD` / `AUTH_PASSWORD_HASH` | | admin password (plain, or a bcrypt hash) |
| `AUTH_PASSWORD_FALLBACK` | `true` | keep the password login next to SSO |
| `AUTH_ALLOWED_EMAILS`, `GITHUB_USERS` | | who may log in with SSO |
| `OIDC_*`, `GOOGLE_*`, `GITHUB_*` | | SSO providers (table above); also `OIDC_SCOPES`, `OIDC_ALLOWED_GROUPS`, `OIDC_GROUPS_CLAIM` |
| `AUTH_HEADER_NAME`, `AUTH_HEADER_TRUSTED` | `Remote-User`, — | header mode |
| `SESSION_TTL` | `168h` | how long a login lasts |
| `AUTH_RESET` | | `1` resets the login settings on start (remove it afterwards) |
| `LOG_LEVEL` | `info` | `debug` logs every request |

Behind a reverse proxy with TLS, set `PUBLIC_URL` and `TRUSTED_PROXIES`, and in Jackett's settings set **Base URL override** to the same public URL so the links Jackett returns to clients are right.

## Development

```
npm install
cd server && JACKETT_URL=http://127.0.0.1:9117 LISTEN=127.0.0.1:8080 DATA_DIR=./.data go run .   # the Go server
UI_SERVER_URL=http://127.0.0.1:8080 npm run dev                                                 # the UI with hot reload
npm run typecheck && npm run lint && npm test
cd server && go vet ./... && go test ./...
```

`docs/server-spec.md` describes the server; `contract/` holds real Jackett responses used as fixtures; `AGENTS.md` has the conventions.

## License

MIT. Jackett itself is GPL-2.0; this project does not include Jackett code.
