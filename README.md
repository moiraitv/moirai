# Moirai

Moirai is a self-hosted IPTV scheduler, media index, and streaming server built around the [ErsatzTV-Next](https://github.com/ErsatzTV/next) channel engine. It discovers local media and Kodi-compatible metadata, provides a media-center-style management UI, and serves an M3U playlist, XMLTV guide, and live HLS channels directly to IPTV clients.

> Moirai is an early working foundation. ErsatzTV-Next itself is under active development, so its JSON contracts may change.

## Quick start

Moirai targets Node.js 24.8 or newer within the Node 24 LTS line and uses npm workspaces. The
repository rejects other versions because authentication uses Node's built-in Argon2id support and
`better-sqlite3` contains a Node-ABI-specific native module.

```sh
nvm use
npm install
npm run dev
```

The development command automatically loads an optional, ignored root `.env`. Copy `.env.example`
to `.env` when local configuration or credentials are needed; variables already exported by the
shell take precedence.

Local development also requires `ffprobe` on `PATH` (normally installed with FFmpeg). Live channel
preview requires the standalone `ersatztv-channel` executable and a working Rust toolchain to build
it. Initialize Moirai's pinned development submodule and build the worker once after cloning:

```sh
npm run etv:setup
npm run etv:build
```

Clone with `--recurse-submodules` to make the setup command a quick verification rather than an
initial download. `MOIRAI_ETV_CHANNEL_PATH` can select a prebuilt worker, while `ETV_NEXT_DIR` can
select an alternate checkout for developers actively changing Next. Otherwise Moirai checks the
pinned `vendor/ersatztv-next` build and then `PATH`. The management UI remains available when the
engine is absent and reports playback as degraded. The production container includes both tools and
does not use the development submodule.

If dependencies were installed before switching to Node 24, run `npm rebuild better-sqlite3` once
after `nvm use`.

Open <http://127.0.0.1:5173>. Vite proxies API requests to Fastify on port 3000. The first visitor
must initialize administrator access with local credentials or a configured Logto application. Do
not expose a new installation before completing this step. The development coordinator automatically
returns OIDC callbacks to Vite; set `MOIRAI_MANAGEMENT_URL` only when using a different browser origin.
For a non-loopback development hostname, Vite binds all interfaces but accepts only that configured
hostname. `MOIRAI_WEB_HOST` can override the bind address. For a production-style local run:

The development command builds and starts the API before launching Vite, then keeps both under one
coordinator. Server source changes rebuild and restart only the API. An unexpected API exit is
restarted with bounded backoff so Vite does not remain permanently disconnected after an isolated
backend failure. Development API shutdown is intentionally immediate: the plain-Node API handles
terminal or coordinator termination by bypassing native cleanup that can otherwise remain stuck on
network-backed filesystem watchers. Moirai requires `better-sqlite3` 13.0.1 or newer for its Node 24
cleanup-hook compatibility fix; the lockfile pins a compatible release.

```sh
npm run build
npm start
```

The production server listens at <http://127.0.0.1:3000> by default and serves both the API and built SPA.

## Technical documentation

See the [technical outline](docs/technical-outline.md) for the system architecture, media indexing,
scheduling and materialization model, IPTV delivery, operational limits, and deployment assumptions.
The deeper [scheduling architecture](docs/scheduling-architecture.md) documents scheduling-specific
decisions and invariants.

Generate offline HTTP and live-event API references with:

```sh
npm run docs:api
```

The command writes OpenAPI 3.1 and AsyncAPI 3.1 JSON, YAML, and self-contained HTML under the ignored
`dist/api-docs/` directory. Open `dist/api-docs/index.html` after generation. Moirai does not expose a
documentation route in production.

## Configuration

| Variable                               | Default                 | Purpose                                                                         |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `MOIRAI_HOST`                          | `127.0.0.1`             | Fastify bind address                                                            |
| `MOIRAI_PORT`                          | `3000`                  | Fastify port                                                                    |
| `MOIRAI_PUBLIC_URL`                    | `http://127.0.0.1:3000` | Client-visible HTTP(S) origin for EPG and artwork URLs; paths are not supported |
| `MOIRAI_MANAGEMENT_URL`                | `MOIRAI_PUBLIC_URL`     | Browser UI origin; may differ only by port for split development servers       |
| `MOIRAI_WEB_PORT`                      | `5173`                  | Development-only Vite server port; unused by production serving                  |
| `MOIRAI_WEB_HOST`                      | Derived                | Optional Vite bind address for development                                      |
| `MOIRAI_TRUST_PROXY`                   | Unset                   | Comma-separated proxy IPs/CIDRs trusted to report original client addresses     |
| `MOIRAI_LOGTO_ENDPOINT`                | Unset                   | Logto tenant origin; enables Logto only when all three Logto values are set     |
| `MOIRAI_LOGTO_APP_ID`                  | Unset                   | Traditional-web application ID issued by Logto                                  |
| `MOIRAI_LOGTO_APP_SECRET`              | Unset                   | Traditional-web application secret; never returned or logged                    |
| `MOIRAI_LOG_LEVEL`                     | `info`                  | Structured server log level                                                     |
| `MOIRAI_LOG_DIR`                       | `<data>/logs`           | Rotating structured server log directory                                        |
| `MOIRAI_LOG_RETENTION_DAYS`            | `14`                    | Maximum age of retained JSONL logs                                              |
| `MOIRAI_LOG_MAX_MB`                    | `200`                   | Maximum total retained log size                                                 |
| `MOIRAI_LOG_FILE_MAX_MB`               | `10`                    | Rotation size for an individual log file                                        |
| `MOIRAI_TIME_ZONE`                     | Host time zone          | IANA time zone used for guide and schedule generation                           |
| `MOIRAI_DATA_DIR`                      | `./data`                | SQLite, artwork cache, and persistent application data                          |
| `MOIRAI_ARTWORK_CACHE_MAX_MB`          | `2048`                  | Maximum persistent artwork cache size                                           |
| `MOIRAI_ARTWORK_CACHE_MAX_ENTRY_MB`    | `25`                    | Maximum size of one cached image                                                |
| `MOIRAI_ARTWORK_TRANSFORM_CONCURRENCY` | `4`                     | Maximum concurrent artwork renders                                              |
| `MOIRAI_FFPROBE_PATH`                  | `ffprobe`               | ffprobe executable used for technical media inspection                          |
| `MOIRAI_MEDIA_PROBE_CONCURRENCY`       | `2`                     | Maximum concurrent media probe processes                                        |
| `MOIRAI_MEDIA_PROBE_TIMEOUT_MS`        | `15000`                 | Deadline for inspecting one media file                                          |
| `MOIRAI_SCHEDULING_WORKERS`            | `2`                     | Timeline worker threads; `0` uses the main thread                               |
| `MOIRAI_SCHEDULING_WORKER_QUEUE`       | `32`                    | Maximum queued/in-flight timeline jobs                                          |
| `MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS`      | `5000`                  | Maximum items in one selected-items program; accepts `1`–`25000`                |
| `MOIRAI_SCAN_CANCEL_GRACE_MS`          | `5000`                  | Wait limit for cancelled native filesystem work                                 |
| `MOIRAI_SHUTDOWN_DEADLINE_MS`          | `10000`                 | Production graceful-shutdown deadline                                           |
| `MOIRAI_SCAN_HISTORY_RETENTION_DAYS`   | `30`                    | Maximum completed scan-history age                                              |
| `MOIRAI_SCAN_HISTORY_MAX_PER_LIBRARY`  | `2000`                  | Maximum completed scans retained per library                                    |
| `MOIRAI_ETV_CHANNEL_PATH`              | Auto-detected           | Standalone `ersatztv-channel` executable                                        |
| `MOIRAI_PLAYBACK_STREAM_DIR`           | `<data>/streams`        | Ephemeral HLS worker output                                                     |
| `MOIRAI_PLAYBACK_PLAYOUT_DIR`          | `<data>/playout`        | Private validated daily playout documents                                       |
| `MOIRAI_PLAYOUT_SYNC_INTERVAL_SECONDS` | `60`                    | Private rolling playout reconciliation interval                                 |
| `MOIRAI_PLAYBACK_READY_TIMEOUT_MS`     | `30000`                 | Deadline for a new HLS worker to become ready                                   |
| `MOIRAI_PLAYBACK_STOP_GRACE_MS`        | `5000`                  | Grace before a channel worker is force-stopped                                  |
| `ETV_NEXT_DIR`                         | Unset                   | Optional alternate developer checkout for Next                                  |

## Docker

```sh
docker compose up --build
```

The example maps persistent application data to `/data`. Add read-only media mounts and configure library scan roots using their container paths. Playback roots, when set, must be paths visible inside the same Moirai container because the integrated channel worker inherits those mounts. Set `MOIRAI_PUBLIC_URL` to an origin reachable by IPTV clients; the application shell and Guide display a prominent warning while the loopback default is in use. The pinned upstream engine image is currently `linux/amd64` only.

Create a **Traditional web** application in Logto. Use `MOIRAI_PUBLIC_URL` for server callbacks and
`MOIRAI_MANAGEMENT_URL` for the browser return after sign-out. The two values normally match. For
example, when both are `https://moirai.example.com`, configure:

| Logto setting              | Value                                                             |
| -------------------------- | ----------------------------------------------------------------- |
| Redirect URI               | `https://moirai.example.com/api/v1/auth/logto/callback`           |
| Post sign-out redirect URI | `https://moirai.example.com/login`                                |
| Backchannel logout URI     | `https://moirai.example.com/api/v1/auth/logto/backchannel-logout` |
| Is session required?       | Yes                                                               |
| Allow token exchange       | No                                                                |

Use exact URIs. The redirect and backchannel URIs use `MOIRAI_PUBLIC_URL`; the post sign-out URI uses
`MOIRAI_MANAGEMENT_URL`. Enabling session identifiers lets Moirai revoke the specific Logto-backed
session identified by a logout token; subject-based revocation remains a fallback. Token exchange is
unnecessary because Moirai uses the OIDC Authorization Code flow and does not perform delegation or
impersonation. The backchannel URI must be reachable by Logto's servers, so a cloud-hosted Logto
tenant cannot call a localhost or private-network address.

Set `MOIRAI_LOGTO_ENDPOINT`, `MOIRAI_LOGTO_APP_ID`, and `MOIRAI_LOGTO_APP_SECRET` from the Logto
application. Any user Logto accepts for it receives full Moirai administration access. Local
authentication stays available as an optional fallback. Logto-backed Moirai sessions expire after 24
hours and require another provider sign-in; disabling Logto or changing its endpoint or application ID
revokes existing provider sessions when the server next starts.

When an HTTPS reverse proxy fronts Moirai, set `MOIRAI_TRUST_PROXY` to that proxy's IP address or
CIDR so authentication throttles use each originating client's forwarded address. Multiple entries
are comma-separated; `loopback`, `linklocal`, and `uniquelocal` groups are also accepted. Trust only
the narrowest proxy ranges you control because clients arriving through a trusted address can supply
forwarding headers.

If local credentials are lost or were never created, run `npm run auth:reset` on the server. The
command prints a single-use recovery URL valid for 15 minutes and does not accept a password through
the shell. It loads the ignored root `.env`, when present, so its database and URLs match local
development. When no management URL was supplied, the command detects an active Vite server before
falling back to the public origin. For the supplied Docker deployment, run:

```sh
docker compose exec moirai npm run auth:reset
```

## Verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:api:check
npx playwright install chromium
npm run test:e2e
```

Set `PLAYWRIGHT_CHROME_PATH` to an existing Chrome or Chromium executable to run the browser test without Playwright's downloaded browser.
