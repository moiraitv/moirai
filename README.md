# Moirai

Moirai is a self-hosted IPTV scheduler, media index, and streaming server built around the [ErsatzTV-Next](https://github.com/ErsatzTV/next) channel engine. It discovers local media and Kodi-compatible metadata, provides a media-center-style management UI, and serves an M3U playlist, XMLTV guide, and live HLS channels directly to IPTV clients.

> Moirai is an early working foundation. ErsatzTV-Next itself is under active development, so its JSON contracts may change.

## Quick start

Moirai targets Node.js 24 LTS and uses npm workspaces. The repository rejects other Node major
versions during dependency installation because `better-sqlite3` contains a Node-ABI-specific
native module.

```sh
nvm use
npm install
npm run dev
```

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

Open <http://127.0.0.1:5173>. Vite proxies API requests to Fastify on port 3000. For a production-style local run:

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

| Variable                               | Default                 | Purpose                                                |
| -------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `MOIRAI_HOST`                          | `127.0.0.1`             | Fastify bind address                                   |
| `MOIRAI_PORT`                          | `3000`                  | Fastify port                                           |
| `MOIRAI_PUBLIC_URL`                    | `http://127.0.0.1:3000` | Client-visible HTTP(S) origin for EPG and artwork URLs; paths are not supported |
| `MOIRAI_LOG_LEVEL`                     | `info`                  | Structured server log level                            |
| `MOIRAI_LOG_DIR`                       | `<data>/logs`           | Rotating structured server log directory               |
| `MOIRAI_LOG_RETENTION_DAYS`            | `14`                    | Maximum age of retained JSONL logs                     |
| `MOIRAI_LOG_MAX_MB`                    | `200`                   | Maximum total retained log size                        |
| `MOIRAI_LOG_FILE_MAX_MB`               | `10`                    | Rotation size for an individual log file               |
| `MOIRAI_TIME_ZONE`                     | Host time zone          | IANA time zone used for guide and schedule generation  |
| `MOIRAI_DATA_DIR`                      | `./data`                | SQLite, artwork cache, and persistent application data |
| `MOIRAI_ARTWORK_CACHE_MAX_MB`          | `2048`                  | Maximum persistent artwork cache size                  |
| `MOIRAI_ARTWORK_CACHE_MAX_ENTRY_MB`    | `25`                    | Maximum size of one cached image                       |
| `MOIRAI_ARTWORK_TRANSFORM_CONCURRENCY` | `4`                     | Maximum concurrent artwork renders                     |
| `MOIRAI_FFPROBE_PATH`                  | `ffprobe`               | ffprobe executable used for technical media inspection |
| `MOIRAI_MEDIA_PROBE_CONCURRENCY`       | `2`                     | Maximum concurrent media probe processes               |
| `MOIRAI_MEDIA_PROBE_TIMEOUT_MS`        | `15000`                 | Deadline for inspecting one media file                 |
| `MOIRAI_SCHEDULING_WORKERS`            | `2`                     | Timeline worker threads; `0` uses the main thread      |
| `MOIRAI_SCHEDULING_WORKER_QUEUE`       | `32`                    | Maximum queued/in-flight timeline jobs                 |
| `MOIRAI_SCAN_CANCEL_GRACE_MS`          | `5000`                  | Wait limit for cancelled native filesystem work        |
| `MOIRAI_SHUTDOWN_DEADLINE_MS`          | `10000`                 | Production graceful-shutdown deadline                  |
| `MOIRAI_SCAN_HISTORY_RETENTION_DAYS`   | `30`                    | Maximum completed scan-history age                     |
| `MOIRAI_SCAN_HISTORY_MAX_PER_LIBRARY`  | `2000`                  | Maximum completed scans retained per library           |
| `MOIRAI_ETV_CHANNEL_PATH`              | Auto-detected           | Standalone `ersatztv-channel` executable               |
| `MOIRAI_PLAYBACK_STREAM_DIR`           | `<data>/streams`        | Ephemeral HLS worker output                            |
| `MOIRAI_PLAYBACK_PLAYOUT_DIR`          | `<data>/playout`        | Private validated daily playout documents              |
| `MOIRAI_PLAYOUT_SYNC_INTERVAL_SECONDS` | `60`                    | Private rolling playout reconciliation interval        |
| `MOIRAI_PLAYBACK_READY_TIMEOUT_MS`     | `30000`                 | Deadline for a new HLS worker to become ready          |
| `MOIRAI_PLAYBACK_STOP_GRACE_MS`        | `5000`                  | Grace before a channel worker is force-stopped         |
| `ETV_NEXT_DIR`                         | Unset                   | Optional alternate developer checkout for Next         |

## Docker

```sh
docker compose up --build
```

The example maps persistent application data to `/data`. Add read-only media mounts and configure library scan roots using their container paths. Playback roots, when set, must be paths visible inside the same Moirai container because the integrated channel worker inherits those mounts. Set `MOIRAI_PUBLIC_URL` to an origin reachable by IPTV clients; the application shell and Guide display a prominent warning while the loopback default is in use. The pinned upstream engine image is currently `linux/amd64` only.

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
