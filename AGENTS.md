# jackett-ui: notes for contributors and agents

A modern web UI for [Jackett](https://github.com/Jackett/Jackett). It is a separate frontend: it talks to the **stock** Jackett API (`/api/v2.0`), Jackett itself is not forked or patched.

## Stack
React 18 + TypeScript, Vite 7, Tailwind 3, shadcn/ui components (Radix) in `src/components/ui`, TanStack Query / Router / Table, lucide icons, sonner toasts, DOMPurify.

## Commands (run on Windows in the repo folder; Node 22 is installed there)
```
npm run typecheck
npm run lint
npm test
npm run build
```
Do not run `npm install`/`npm ci` concurrently with someone else. If you need a new dependency, say so in your report instead of installing it.

`npm run dev` proxies `/api`, `/dl`, `/bh`, `/UI`, `/_ui`, `/healthz` to the jackett-ui Go server at `UI_SERVER_URL` (default `http://127.0.0.1:8080`), which handles auth and talks to Jackett (see `docs/server-spec.md`).

## API contract
- `src/api/types.ts`: types for every response, taken from live Jackett v0.24.
- `src/api/index.ts`: the client (`api.*`), query keys (`qk`), link helpers (`searchUrl`, `torznabUrl`, `localizeLink`). Use these, do not call `fetch` directly.
- `contract/`: real responses captured from a live Jackett. Use them as test fixtures:
  - `indexers.sample.json`: 38 entries of `GET /indexers` (the real list has ~650, ~1.5 MB).
  - `configs/*.json`: `GET /indexers/{id}/config` for ~80 trackers; `field-type-examples.json`: one example per field type.
  - `results-all.json`: a search response (100 RuTor results). `logs.json`, `cache.json`, `test-rutor.json` (error body), `torznab-caps.xml`.

Facts worth knowing:
- Errors: HTTP 500 with `{ result: "error", error, stacktrace }` → `ApiError.message` is `error`.
- Saving an indexer config (`POST /indexers/{id}/config`) is also how an indexer is **added**: Jackett logs in to the tracker during save, so save errors are tracker errors (wrong password, captcha, Cloudflare "Challenge detected but FlareSolverr is not configured"). 204 = OK.
- Field list must be posted back **complete and in order**, including `displayinfo`/`displayimage` rows and fields with `id: ""`. Only change `value` (or `values` for `inputcheckbox`).
- Fields named like password/passkey/apikey/cookie/pid/rss key are plain `inputstring` in Jackett: mask them in the UI (with a reveal toggle).
- `displayimage` is usually a captcha (`data:` URL) shown next to an `inputstring` "Captcha Text". Re-fetch the config to get a fresh captcha.
- `test` (POST `/indexers/{id}/test`): 204 OK, 500 with error. Can take 5–30 s.
- Search: `GET /indexers/all/results?apikey=…&Query=…&Tracker[]=id&Category[]=2000`. Response `Indexers[]` has per-tracker `Status` (2 OK, 1 error), `Results`, `Error`, `ElapsedTime`.
- Result `Link` is an absolute URL built from the host Jackett saw: always pass it through `localizeLink()`.
- Changing proxy settings in server config makes Jackett restart (a few seconds of failed requests).
- Torznab category ids: 1000 Console, 2000 Movies, 3000 Audio, 4000 PC, 5000 TV, 6000 XXX, 7000 Books, 8000 Other; subcategories are `+10..+90`; ids ≥ 100000 are tracker-specific.

## Conventions
- **UI language: Russian.** Code, comments and identifiers: English. Write short, plain labels.
- Reuse `src/components/common.tsx` (`PageHeader`, `EmptyState`, `ErrorState`, `Callout`, `ConfirmDialog`, `CopyButton`, `CopyField`, `RelativeTime`, `StatusDot`, `Field`, `toastError`, `HelpTip`, `Mono`) and `src/components/data-table.tsx`.
- Raw HTML only through `SafeHtml` (`src/components/safe-html.tsx`). `dangerouslySetInnerHTML` is banned by lint.
- Server state only via TanStack Query with keys from `qk`. Invalidate `qk.indexers` after add/edit/delete.
- Mobile works: tables collapse to cards or scroll inside their container; no horizontal page scroll at 375 px.
- Dark mode works (use the theme tokens: `bg-background`, `text-muted-foreground`, `border` …, no hard-coded colors except status colors via Tailwind `emerald/amber/red` with `dark:` variants).
- Accessibility: labels on inputs, `aria-label` on icon buttons, keyboard works in dialogs.
- Keep each page self-contained: put page-specific components in `src/pages/<page>/` or `src/components/<feature>/`. Do **not** edit shared files (`src/api/*`, `src/components/ui/*`, `common.tsx`, `data-table.tsx`, `router.tsx`, `AppShell.tsx`) unless your task says so. New shadcn components go into new files in `src/components/ui/`.
- Unit tests (vitest + Testing Library) for non-trivial pure logic (form ↔ field mapping, filters, query building). Fixtures from `contract/`.
