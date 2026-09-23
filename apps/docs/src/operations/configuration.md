---
id: operations.configuration
title: Configuration reference
description: Understand the environment settings most operators need to change.
contextual: false
---

# Configuration reference

Most installations need only a few environment values:

| Setting | What it controls |
| --- | --- |
| `MOIRAI_PUBLIC_URL` | HTTP or HTTPS origin that IPTV clients use for playlists, guide data, artwork, and streams. |
| `MOIRAI_MANAGEMENT_URL` | Browser origin when the management interface uses a different port. |
| `MOIRAI_DATA_DIR` | Persistent database, artwork cache, logs, and playback working files. |
| `MOIRAI_PLAYBACK_STREAM_DIR` | Folder for generated playback/transcode output. Defaults to `streams` inside the data directory (`/data/streams` in Docker). An absolute path can point to a separate writable mount. |
| `MOIRAI_TIME_ZONE` | Local time zone used for guide dates and schedule boundaries. |
| `MOIRAI_LOG_LEVEL` | Amount of server detail retained in logs. |
| `MOIRAI_TRUST_PROXY` | Narrow IP addresses or networks allowed to supply forwarded client addresses. |

The supplied image listens on port 3000 and stores state under `/data`. Media folders need separate read-only mounts. You can also [map a writable transcode folder](/getting-started/docker) separately from persistent application data. Hardware acceleration devices and their owning group IDs must also be passed into the container explicitly.

Keep secrets such as `MOIRAI_LOGTO_APP_SECRET` outside version control. Trust only reverse proxies you control; an overly broad `MOIRAI_TRUST_PROXY` lets clients influence the address used for security throttling.

## Set environment values

With Docker Compose, add settings under the service's `environment` section. A value in a host `.env` file reaches the container only when the Compose file references it or loads it through `env_file`. Recreate the container after changing its configuration with `docker compose up -d`.

For a local checkout, `npm run dev` loads the root `.env` file. A built local server can load it with `node --env-file-if-exists=.env apps/server/dist/main.js`; `npm start` does not load it automatically. Values already exported in the shell take precedence.

## All environment settings

These are the application defaults. The Docker image overrides `MOIRAI_HOST` to `0.0.0.0`, `MOIRAI_DATA_DIR` to `/data`, and `MOIRAI_ETV_CHANNEL_PATH` to `/app/ersatztv-channel`. The repository's source-build Compose file also sets `MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS` to `500` unless overridden; the application default is `5000`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOIRAI_HOST` | `127.0.0.1` | Server bind address |
| `MOIRAI_PORT` | `3000` | Server port |
| `MOIRAI_PUBLIC_URL` | `http://127.0.0.1:<MOIRAI_PORT>` | HTTP(S) origin that viewers can reach; paths are not supported |
| `MOIRAI_MANAGEMENT_URL` | `MOIRAI_PUBLIC_URL` | Browser UI origin; may differ only by port for split development servers |
| `MOIRAI_WEB_PORT` | `5173` | Development-only Vite server port; unused by production serving |
| `MOIRAI_WEB_HOST` | Derived | Optional Vite bind address for development |
| `MOIRAI_TRUST_PROXY` | Unset | Comma-separated proxy IPs/CIDRs trusted to report original client addresses |
| `MOIRAI_LOGTO_ENDPOINT` | Unset | Logto tenant origin; enables Logto only when all three Logto values are set |
| `MOIRAI_LOGTO_APP_ID` | Unset | Traditional-web application ID issued by Logto |
| `MOIRAI_LOGTO_APP_SECRET` | Unset | Traditional-web application secret; never returned or logged |
| `MOIRAI_LOG_LEVEL` | `info` | Structured server log level |
| `MOIRAI_LOG_DIR` | `<data>/logs` | Rotating structured server log directory |
| `MOIRAI_GUIDE_DAYS` | `7` | Guide and XMLTV horizon in local calendar days, including today; accepts 1–14. One extra day is generated internally. |
| `MOIRAI_LOG_RETENTION_DAYS` | `14` | Maximum age of retained JSONL logs |
| `MOIRAI_LOG_MAX_MB` | `200` | Maximum total retained log size |
| `MOIRAI_LOG_FILE_MAX_MB` | `10` | Rotation size for an individual log file |
| `MOIRAI_TIME_ZONE` | Host time zone | IANA time zone used for guide and schedule generation |
| `MOIRAI_DATA_DIR` | `./data` | SQLite, artwork cache, and persistent application data |
| `MOIRAI_ARTWORK_CACHE_MAX_MB` | `2048` | Maximum persistent artwork cache size |
| `MOIRAI_ARTWORK_CACHE_MAX_ENTRY_MB` | `25` | Maximum size of one cached image |
| `MOIRAI_ARTWORK_TRANSFORM_CONCURRENCY` | `4` | Maximum concurrent artwork renders |
| `MOIRAI_FFPROBE_PATH` | `ffprobe` | ffprobe executable used for technical media inspection |
| `MOIRAI_MEDIA_PROBE_CONCURRENCY` | `2` | Maximum concurrent media probe processes |
| `MOIRAI_MEDIA_PROBE_TIMEOUT_MS` | `15000` | Deadline for inspecting one media file |
| `MOIRAI_SCHEDULING_WORKERS` | `2` | Timeline worker threads; `0` uses the main thread |
| `MOIRAI_SCHEDULING_WORKER_QUEUE` | `32` | Maximum queued/in-flight timeline jobs |
| `MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS` | `5000` | Maximum items in one selected-items program; accepts `1`–`25000` |
| `MOIRAI_SCAN_CANCEL_GRACE_MS` | `5000` | Wait limit for cancelled native filesystem work |
| `MOIRAI_SHUTDOWN_DEADLINE_MS` | `10000` | Production graceful-shutdown deadline |
| `MOIRAI_SCAN_HISTORY_RETENTION_DAYS` | `30` | Maximum completed scan-history age |
| `MOIRAI_SCAN_HISTORY_MAX_PER_LIBRARY` | `2000` | Maximum completed scans retained per library |
| `MOIRAI_ETV_CHANNEL_PATH` | Auto-detected | Standalone `ersatztv-channel` executable |
| `MOIRAI_PLAYBACK_STREAM_DIR` | `<data>/streams` | Ephemeral HLS worker output |
| `MOIRAI_PLAYBACK_PLAYOUT_DIR` | `<data>/playout` | Private validated daily playout documents |
| `MOIRAI_PLAYOUT_SYNC_INTERVAL_SECONDS` | `60` | Seconds between playback schedule updates |
| `MOIRAI_PLAYBACK_READY_TIMEOUT_MS` | `30000` | Deadline for a new HLS worker to become ready |
| `MOIRAI_PLAYBACK_STOP_GRACE_MS` | `5000` | Grace before a channel worker is force-stopped |
| `ETV_NEXT_DIR` | Unset | Optional alternate developer checkout for Next |

`MOIRAI_DEBUG` also enables extra diagnostics when set to `1` or `true`; it is off by default.

Use an IANA time zone such as `America/New_York` for `MOIRAI_TIME_ZONE` when the server's default does not match your schedule. In Docker, set it explicitly for predictable local schedule times.

Relative `MOIRAI_DATA_DIR` and explicit `MOIRAI_LOG_DIR` paths resolve from the project root. Relative stream and playout paths resolve inside `MOIRAI_DATA_DIR`. Keep the data directory persistent and use container paths for media libraries and playback roots.

`MOIRAI_PUBLIC_URL` and `MOIRAI_MANAGEMENT_URL` must use the same scheme and hostname; only their ports may differ. Development normally uses port 5173 for the browser and port 3000 for the API. The development command selects the browser return address automatically unless `MOIRAI_MANAGEMENT_URL` is set.

Configure all three Logto values together or leave all three unset. See [Set up Logto](/getting-started/access) for provider settings and callback URLs.

For `MOIRAI_TRUST_PROXY`, supply only the proxy addresses or CIDRs you control. Multiple entries are comma-separated; `loopback`, `linklocal`, and `uniquelocal` groups are also accepted. This lets Moirai use the original client address for sign-in rate limits when requests arrive through a trusted proxy.

## Local playback tools

`MOIRAI_ETV_CHANNEL_PATH` selects a prebuilt channel worker. Otherwise Moirai checks `ETV_NEXT_DIR`, the pinned development submodule's build, and then `PATH`. The management UI remains available without the worker, but playback is unavailable. The Docker image already includes the worker and media inspection tools.

`MOIRAI_WEB_PORT` and `MOIRAI_WEB_HOST` apply only to local development. For a non-loopback development hostname, the web server binds all interfaces but accepts only the configured hostname. `MOIRAI_WEB_HOST` can override the bind address.

## Local similarity model

Similar Items Programs use `BAAI/bge-small-en-v1.5` locally on the CPU. Every server build packages the pinned ONNX model, tokenizer, and license in `apps/server/dist/embedding-model`. Container images include that complete server build. Native deployments should copy the entire server `dist` directory, including the model folder. Changing `MOIRAI_DATA_DIR` does not change the bundled model location.

One background worker prepares the library, releases the model after a minute without work, and suspends under system resource pressure. English descriptions give the best results with this model. If the bundle is incomplete, Similar Items may show an error while the rest of Moirai remains available; rebuild or reinstall may be needed to fix it.
