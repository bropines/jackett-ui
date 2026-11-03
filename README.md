# jackett-ui

A modern web UI for [Jackett](https://github.com/Jackett/Jackett), built with React and [shadcn/ui](https://ui.shadcn.com).

It is a **separate frontend**, not a fork: it talks to the stock Jackett API, so Jackett keeps getting its (almost daily) tracker fixes from upstream. The image is a tiny nginx that serves the UI and proxies the Jackett API, so you put it in front of an existing Jackett and that's it.

- Fast search across all trackers: filters by tracker and category, sorting, magnet / .torrent / tracker page, shareable search URLs
- Tracker catalog (~650 trackers) with search and filters by type, language and category
- Tracker settings form for every tracker type (captcha, tags, checkbox groups…)
- Test one / all trackers, copy Torznab links and the API key
- Server settings (proxy, FlareSolverr, cache…), logs
- Dark mode, works on phones

UI language: Russian (for now).

## Run

### All-in-one (simplest)

One container: the stock [linuxserver.io Jackett](https://docs.linuxserver.io/images/docker-jackett) image with jackett-ui added on port 8080. Same `/config`, `PUID`, `PGID` and `TZ` as the linuxserver image, so you can switch an existing install by changing the image name.

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
      - "8080:8080"   # new UI (proxies the Jackett API)
      - "9117:9117"   # Jackett's own UI and API (optional)
    restart: unless-stopped
```

The image is rebuilt daily when a new Jackett version comes out: `:aio` is always the newest, `:aio-v0.24.2994-ls24` pins one Jackett build.

### UI next to an existing Jackett

```yaml
services:
  jackett:
    image: lscr.io/linuxserver/jackett:latest
    volumes: [./config:/config]

  jackett-ui:
    image: ghcr.io/bropines/jackett-ui:latest
    environment:
      JACKETT_URL: http://jackett:9117   # where the UI container reaches Jackett
    ports:
      - "8080:8080"
```

Open http://localhost:8080. Jackett's own UI keeps working on its port.

| Env | Default | |
|---|---|---|
| `JACKETT_URL` | `http://jackett:9117` | Jackett base URL as seen from the container |
| `LISTEN_PORT` | `8080` | Port nginx listens on |

### Kubernetes (Helm): Jackett and the UI in one release

The chart `charts/jackett` runs Jackett (stock linuxserver image) and jackett-ui in one pod, with a volume for `/config`. The Service exposes only the UI, which proxies the Jackett API.

```
helm install jackett oci://ghcr.io/bropines/charts/jackett --version 0.1.0 \
  --set persistence.storageClassName=longhorn \
  --set ingress.enabled=true --set ingress.className=traefik --set ingress.host=jackett.example.com
```

Jackett settings can be set from values. An init container writes them into `ServerConfig.json` before Jackett starts. Only the keys you set are written, so the rest stays editable in the UI.

| Value | |
|---|---|
| `jackett.settings.baseUrlOverride` | Public URL, for correct download/Torznab links behind a proxy |
| `jackett.settings.proxy.{type,url,port,username,password}` | Proxy to reach blocked trackers (`type`: -1 off, 0 HTTP, 1 SOCKS4, 2 SOCKS5; prefer HTTP) |
| `jackett.settings.flaresolverrUrl` | FlareSolverr for trackers behind a Cloudflare challenge |
| `jackett.settings.updateDisabled` | `true` by default: update by bumping the image tag |
| `jackett.apiKeySecret.name` | Secret with key `apiKey`: a fixed API key that survives reinstalls |

See `charts/jackett/values.yaml` for everything else (images, resources, persistence, ingress).

### Authentication

- If Jackett has **no admin password**, the UI logs in by itself. Put it behind your own auth (SSO / oauth2-proxy / basic auth) when it is reachable from the internet.
- If Jackett has an admin password, the UI asks for it.
- Search, Torznab and download URLs (`/api/v2.0/indexers/*/results*`, `/dl/*`, `/bh/*`) are protected by the Jackett API key, like in Jackett itself. When you put the UI behind SSO, let these paths through without SSO so qBittorrent's search plugin and *arr apps keep working.
- Behind a reverse proxy with TLS, set **Base URL override** in Settings to your public URL (e.g. `https://jackett.example.com`) so the links Jackett returns to clients are correct.

## Development

```
npm install
JACKETT_URL=http://127.0.0.1:9117 npm run dev   # proxies the API to a running Jackett
npm run typecheck && npm run lint && npm test
npm run build
```

`contract/` holds real responses from Jackett v0.24 used as fixtures. See `AGENTS.md` for conventions.

## License

MIT. Jackett itself is GPL-2.0; this project does not include Jackett code.
