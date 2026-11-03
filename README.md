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
