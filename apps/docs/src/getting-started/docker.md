---
id: installation.docker
title: Install with Docker
description: Run Moirai with persistent data and read-only access to your media.
contextual: false
---

# Install with Docker

Docker is the simplest supported way to run Moirai because the image includes the media inspection
and channel playback tools it needs.

## Before you start

Choose a permanent location for application data and identify the folders containing your media.
The supplied Compose file stores application data in a named volume. Add each media folder as a
read-only mount so a mistake in Moirai cannot change the source files.

```yaml
services:
  moirai:
    volumes:
      - moirai-data:/data
      - /srv/media/movies:/media/movies:ro
      - /srv/media/shows:/media/shows:ro
```

Start the service with:

```sh
docker compose up --build -d
```

Open `http://<server-address>:3000`. The first visitor is allowed to create the administrator, so
complete [administrator setup](/getting-started/access) before making the service reachable from an
untrusted network.

Set `MOIRAI_PUBLIC_URL` to the address that IPTV clients can reach. A loopback address such as
`127.0.0.1` works only when the client runs on the same machine.

Your media paths inside Moirai are the container paths, such as `/media/movies`, not the original
host paths. Keep `/data` persistent when replacing or upgrading the container.
