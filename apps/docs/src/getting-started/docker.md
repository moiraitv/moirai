---
id: installation.docker
title: Install with Docker
description: Run Moirai with persistent data and read-only access to your media.
contextual: false
---

# Install with Docker

Docker is the simplest supported way to run Moirai because the image includes the media inspection and channel playback tools it needs.

## Before you start

Choose a permanent location for application data and identify the folders containing your media. The supplied Compose file stores application data in a named volume. Add each media folder as a read-only mount so a mistake in Moirai cannot change the source files.

```yaml
services:
  moirai:
    volumes:
      - moirai-data:/data
      - /srv/media/movies:/media/movies:ro
      - /srv/media/shows:/media/shows:ro
```

## Optional transcode storage

You can map a separate host folder for temporary playback/transcode output. This keeps generated stream files on storage you choose instead of inside the application-data volume. The default container path is `/data/streams`:

```yaml
services:
  moirai:
    volumes:
      - moirai-data:/data
      - /srv/moirai/transcode:/data/streams
      - /srv/media/movies:/media/movies:ro
      - /srv/media/shows:/media/shows:ro
```

Replace `/srv/moirai/transcode` with your chosen host folder. Create it with permissions that allow the container user to write to it, and leave this mount writable—do not add `:ro`. Keep enough free space for generated output, and do not delete files from this folder while playback is running. Your original media mounts should remain read-only.

If you prefer a different container path, set `MOIRAI_PLAYBACK_STREAM_DIR` to that path and mount the host folder there. For example, use `MOIRAI_PLAYBACK_STREAM_DIR: /transcode` with `/srv/moirai/transcode:/transcode`. Add the environment setting to the service's `environment` section in Compose; setting it only in a host `.env` file does not automatically pass it into the container.

This folder contains generated playback files, not your media library or database. Keep `/data` persistent even when transcode storage is mounted separately.

### Prefer tmpfs

On Linux, a **tmpfs mount** is a good choice for temporary transcode output when the host has enough spare RAM. It keeps generated files in memory, reducing disk writes. Unlike a persistent Docker volume, its contents disappear when the container stops; the operating system may still write memory to swap. See [Docker's tmpfs documentation](https://docs.docker.com/engine/storage/tmpfs/).

In Compose, replace the transcode bind mount with this entry under the service's `volumes`, retaining the existing `/data` and read-only media mounts:

```yaml
- type: tmpfs
  target: /data/streams
  tmpfs:
    size: 2147483648
    mode: 01777
```

For the standalone `docker run` example below, replace its transcode bind-mount option with:

```sh
--mount type=tmpfs,target=/data/streams,tmpfs-size=2147483648,tmpfs-mode=1777
```

Use only one mount at `/data/streams`. The example caps it at **2 GiB**, not a universal recommendation. Choose a limit for your concurrent playback workload while leaving memory for Moirai, the playback engine, and the host. Tmpfs usage counts toward container memory limits; exhaustion can interrupt playback or cause out-of-memory failures. Use disk-backed storage if memory is limited. Never replace the persistent `/data` mount with tmpfs.

## Start Moirai

Choose either Compose or a standalone container; do not run both against the same application-data volume. The examples use the same container name and host port, so they cannot run side by side unchanged.

### With Compose

Start the service from the repository directory with:

```sh
docker compose up --build -d
```

For VAAPI hardware access, enable the `/dev/dri` device mapping and the appropriate `group_add` entries shown as comments in the supplied `compose.yaml`. Replace the example group IDs with those from your host.

### As a standalone container

The example below uses `moirai:latest`. Replace `latest` with a specific release tag when you want to pin the container to that version.

The following Linux example passes `/dev/dri` through for VAAPI-capable hardware. Before running it, replace `VIDEO_GID` and `RENDER_GID` with the numeric groups owning your host's GPU device nodes; `ls -ln /dev/dri` shows them. Use only the groups needed by your devices. Replace the example server address and host folders, and prepare the writable transcode folder as described above.

```sh
docker run -d \
  --name moirai \
  --restart unless-stopped \
  --publish 3000:3000 \
  --env MOIRAI_PUBLIC_URL=http://192.168.1.100:3000 \
  --mount type=volume,source=moirai-data,target=/data \
  --mount type=bind,source=/srv/moirai/transcode,target=/data/streams \
  --mount type=bind,source=/srv/media/movies,target=/media/movies,readonly \
  --mount type=bind,source=/srv/media/shows,target=/media/shows,readonly \
  --device /dev/dri:/dev/dri \
  --group-add VIDEO_GID \
  --group-add RENDER_GID \
  moirai:latest
```

Omit the transcode mount if you want generated output to stay in the data volume. The standalone volume name `moirai-data` is literal; Compose normally prefixes its volume name with the project name. Switching between these examples does not automatically reuse an existing Compose installation's data.

**Hardware access is platform-specific.** `/dev/dri` is not a universal GPU mapping: other hardware may require different device nodes, host drivers, or a vendor-specific container runtime. If using software playback, remove the device and GPU group options. Passing a device through only grants access; select and verify a compatible option in [Playback settings](/playback/settings). Avoid granting unrestricted container privileges just to bypass device permissions.

See Docker's [container run reference](https://docs.docker.com/engine/containers/run/) for mount, device, and supplementary-group options.

### Open the application

Open `http://<server-address>:3000`. The first visitor is allowed to create the administrator, so complete [administrator setup](/getting-started/access) before making the service reachable from an untrusted network.

Set `MOIRAI_PUBLIC_URL` to the address that IPTV clients can reach. A loopback address such as `127.0.0.1` works only when the client runs on the same machine.

Your media paths inside Moirai are the container paths, such as `/media/movies`, not the original host paths. Keep `/data` persistent when replacing or upgrading the container.
