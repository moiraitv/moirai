---
id: operations.configuration
title: Configuration reference
description: Understand the environment settings most operators need to change.
contextual: false
---

# Configuration reference

Most installations need only a few environment values:

| Setting                 | What it controls                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `MOIRAI_PUBLIC_URL`     | HTTP or HTTPS origin that IPTV clients use for playlists, guide data, artwork, and streams. |
| `MOIRAI_MANAGEMENT_URL` | Browser origin when the management interface uses a different port.                         |
| `MOIRAI_DATA_DIR`       | Persistent database, artwork cache, logs, and playback working files.                       |
| `MOIRAI_TIME_ZONE`      | Local time zone used for guide dates and schedule boundaries.                               |
| `MOIRAI_LOG_LEVEL`      | Amount of server detail retained in logs.                                                   |
| `MOIRAI_TRUST_PROXY`    | Narrow IP addresses or networks allowed to supply forwarded client addresses.               |

The supplied image listens on port 3000 and stores state under `/data`. Media folders need separate
read-only mounts. Hardware acceleration devices and their owning group IDs must also be passed into
the container explicitly.

Keep secrets such as `MOIRAI_LOGTO_APP_SECRET` outside version control. Trust only reverse proxies you
control; an overly broad `MOIRAI_TRUST_PROXY` lets clients influence the address used for security
throttling.

See the root project README for the complete environment-variable table and development-only options.
