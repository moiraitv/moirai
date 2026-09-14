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

Before starting with GPU acceleration, apply the device and permission settings under [Hardware acceleration](#hardware-acceleration). The supplied Compose file includes a commented Intel/AMD example; NVIDIA uses its own runtime configuration.

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

## Hardware acceleration

Configure GPU access on the Docker host before choosing acceleration in Moirai. Merge the relevant example below into the supplied Compose service or standalone container configuration.

### Intel and AMD on Linux

List the host render devices and their numeric owning groups:

```sh
ls -l /dev/dri/renderD*
stat -c '%g %n' /dev/dri/renderD*
```

Choose the render node for your GPU; often there is only one, but it isn't necessarily the first node on a multi-GPU host. The following example uses `/dev/dri/renderD128`. Export its actual group ID in the shell where you run Compose, or put that numeric value in the project's `.env` file as `MOIRAI_RENDER_GID`:

```sh
export MOIRAI_RENDER_GID=$(stat -c '%g' /dev/dri/renderD128)
```

#### Composer

```yaml
services:
  moirai:
    devices:
      - /dev/dri/renderD128:/dev/dri/renderD128
    group_add:
      - '${MOIRAI_RENDER_GID:?Set the host render device group ID}'
```

#### Standalone

For a standalone `docker run`, the corresponding options are `--device /dev/dri/renderD128:/dev/dri/renderD128 --group-add "$MOIRAI_RENDER_GID"`. Use the same device path in Moirai's VAAPI settings when selecting a device explicitly. Intel commonly uses QSV or VAAPI; AMD on Linux commonly uses VAAPI with the `radeonsi` driver. The host still needs a working GPU driver.

---

Recreate the service after changing devices or supplementary groups. A simple restart does not apply a changed container configuration:

```sh
docker compose up -d --force-recreate moirai
```

Verify access as the normal container user, not root:

```sh
docker compose exec moirai sh -c 'id; ls -ln /dev/dri; test -r /dev/dri/renderD128 && test -w /dev/dri/renderD128'
```

An absent node means the host driver or device mapping needs attention. A visible node without read/write access means the numeric group mapping or a host access policy needs attention. If Unix permissions are correct, check SELinux or other container security policies on the host. Avoid using privileged mode or making device nodes world-writable as a shortcut.

### NVIDIA on Linux

Install a compatible NVIDIA host driver and follow the [NVIDIA Container Toolkit installation guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) to configure Docker. Verify the host with `nvidia-smi`, then add GPU access to the Moirai service:

#### Composer

```yaml
services:
  moirai:
    environment:
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,video,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

These environment entries supplement the existing service environment. To select one GPU, replace `count: all` with `device_ids: ['GPU-UUID']`, using the GPU UUID reported by `nvidia-smi -L`, and set `NVIDIA_VISIBLE_DEVICES` to the same UUID. Do not specify both `count` and `device_ids`. See [Docker's GPU Compose documentation](https://docs.docker.com/compose/how-tos/gpu-support/).

#### Standalone

For standalone Docker, use `--gpus all --env NVIDIA_VISIBLE_DEVICES=all --env NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`. 

---

Recreate the container after changing GPU access, then verify it as the normal runtime user:

```sh
docker compose exec moirai nvidia-smi
```

A successful `nvidia-smi` confirms GPU visibility; it does not prove that the chosen video codec, bit depth, or resolution can be encoded. In Moirai, **CUDA** is the NVIDIA backend and uses NVENC for encoding. Use the in-app check below to verify an actual encode.

### Verify in Moirai

Open an encoding profile or a channel's custom video settings, select **Automatic**, and set a concrete width, height, format, and bit depth. Expand **Hardware acceleration setup and diagnostics**. Moirai attempts a bounded one-frame encode using the FFmpeg executable and hardware visible to the server process.

On failure, the details distinguish **Device missing**, **Permission denied**, **Encoder unavailable**, and **Driver unavailable** errors. A successful check identifies the backend that encoded that target; it does not guarantee every source codec or filter combination will work -- confirm real playback afterward under **Status**.

Results may be cached for up to five minutes. After correcting a driver or permission issue without recreating the container, wait for that cache to expire or restart Moirai. Source-sized output cannot be predicted; choose concrete dimensions for the check. Explicit backend settings remain available, but do not run this Automatic prediction.

### Other hosts

The Linux device examples do not apply to native Windows or macOS installations. Native macOS uses VideoToolbox. Docker Desktop runs Linux containers inside a VM, so a host GPU is not automatically available to Moirai; mapping `/dev/dri` cannot expose an Apple GPU. Windows GPU containers require an explicitly supported Docker/WSL GPU setup. Moirai's supplied container image currently targets `linux/amd64`; an emulated container may not hardware acceleration.

## Open the application

Open `http://<server-address>:3000`. The first visitor is allowed to create the administrator, so complete [administrator setup](/getting-started/access) before making the service reachable from an untrusted network.

Set `MOIRAI_PUBLIC_URL` to the address that IPTV clients can reach. A loopback address such as `127.0.0.1` works only when the client runs on the same machine.

Your media paths inside Moirai are the container paths, such as `/media/movies`, not the original host paths. Keep `/data` persistent when replacing or upgrading the container.
