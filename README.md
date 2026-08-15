# Vestigator

Track the people you care about. Create a tracking link, send it to someone,
and watch them arrive live on a map — with ETA, driving route, auto-arrival
detection and offline/stale warnings.

Everything runs as **one Node server**: API, WebSocket (socket.io) and the
built React client, all on a single port.

## Features

- Create a booking, then share a private `/join/:id?t=...` link.
- The person taps **Start sharing location** (browser geolocation, no app).
- Live position, path and driving route on a MapLibre map (OSM tiles, OSRM routing).
- Distance remaining + ETA, adjusted for the person's live speed.
- **Auto-arrival**: the booking flips to *Arrived* automatically when the
  person comes within `ARRIVE_THRESHOLD_M` metres of the destination.
- **Offline/stale detection**: the tracker shows when the person went offline
  (socket dropped) or when their location is stale (no update in 90 s).
- **Connection resilience**: the person's page reconnects automatically,
  re-joins the socket session and shows a "reconnecting" state.
- Password reset via SMTP (console-logged when SMTP isn't configured).

## Local development

```bash
npm install
npm run dev        # server (:4001, auto-reload) + vite (:5174, proxy to 4001)
npm test           # server auth/API/socket test suite
npm run build      # production client build
```

Dev servers: http://localhost:5174 (UI), API + socket proxied to
http://localhost:4001.

## Single-server production

```bash
npm ci
npm run build            # client -> client/dist
NODE_ENV=production node server/index.js
```

That's it — `http://<host>:4001` serves the app, API and WebSocket. For a
local smoke test over plain HTTP, run with `SERVE_STATIC=1` instead of
`NODE_ENV=production` (so session cookies work without TLS).

### Docker

```bash
docker build -t vestigator .
docker run -d -p 4001:4001 \
  -e NODE_ENV=production \
  -e APP_URL=https://vestigator.example.com \
  -e COOKIE_SECURE=1 \
  -e SMTP_HOST=... -e SMTP_PORT=587 -e SMTP_SECURE=0 \
  -e SMTP_USER=... -e SMTP_PASS=... -e MAIL_FROM=... \
  -v vestigator-data:/app/server/data \
  vestigator
```

Put it behind HTTPS (Caddy / nginx / a load balancer); `COOKIE_SECURE=1` and
HSTS are enabled in production.

## Deploy on Render (one click)

This repo ships a `render.yaml` blueprint, so Render provisions the service
automatically:

1. Push the repo to GitHub (or GitLab).
2. On Render: **New > Blueprint** → connect that repo.
3. It builds (`npm ci && npm run build`) and starts `node server/index.js`
   with `NODE_ENV=production`, serving the whole app over HTTPS at
   `https://vestigator.onrender.com` (free subdomain; add a custom domain
   later in **Settings > Domains**).

Notes:

- Free tier has an **ephemeral filesystem** — the SQLite DB resets on
  restart/redeploy, and the service spins down after ~15 min idle (wakes on
  the next request). Upgrade to a paid instance and uncomment the `disk`
  block in `render.yaml` for persistent data.
- Set `SMTP_*` / `MAIL_FROM` under the service's **Environment** tab so
  password-reset emails send for real (otherwise they're logged to console).

## Configuration

See `.env.example` for the full list. Key variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4001` | HTTP port |
| `NODE_ENV` | — | `production` enables secure cookies + static client serving |
| `SERVE_STATIC` | — | `1` serves the built client over plain HTTP (local test) |
| `APP_URL` | request host | Public base URL for links in emails |
| `COOKIE_SECURE` | — | Force Secure cookies + HSTS |
| `DATA_DIR` | `server/data` | Where the SQLite DB lives |
| `ARRIVE_THRESHOLD_M` | `80` | Distance that triggers auto-arrival |
| `TRACK_CODE_TTL_MIN` | `10` | Profile track-code lifetime (minutes) |
| `OSRM_SERVER` | `https://router.project-osrm.org` | Routing/ETA server |
| `SMTP_*` / `MAIL_FROM` | — | Outbound email for password resets |

## Notes

- Location data is stored per booking in SQLite (`server/data/vestigator.db`).
- Map tiles: CARTO basemaps + OpenStreetMap; routing: OSRM. The Content
  Security Policy only allows those specific hosts.
- The person's location is only shared while their page is open and they're
  actively sharing; they can stop any time.
