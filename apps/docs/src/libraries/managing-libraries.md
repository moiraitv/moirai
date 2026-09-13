---
id: libraries.manage
title: Libraries and scanning
description: Add media sources and understand what happens during a scan.
contextual: true
---

# ![](/icons/library.svg) Libraries and scanning

Choose **Add Library** to open the library editor. Enter the source details, then choose **Add and Scan**. **Reset** discards the draft after confirmation; closing the editor also protects unsaved changes.

![Add Library editor](/screenshots/library-create.png)

A ![](/icons/library.svg) Library tells Moirai where media lives. Open **![](/icons/library.svg) Libraries** to add a source, see its current health, or start a synchronization.

![The libraries page before a source is added](/screenshots/libraries.png)

Use the path as Moirai sees it. In Docker this is normally a mounted path such as `/media/movies`. Moirai reads video files and Kodi-compatible NFO sidecars, probes technical playback facts, and keeps an index in its database. The original media remains the source of truth.

See [Media file naming](/libraries/media-file-naming) for recommended movie and show layouts, episode numbering, editions, multi-part videos, artwork, NFO files, and subtitle names.

Direct streaming from media center software such as Jellyfin, Plex, Emby, and similar services is not currently supported. Make the underlying media files available to Moirai through a filesystem path instead, such as a folder mounted into its Docker container.

The first scan can take time for a large collection. A source watcher handles ordinary additions and changes afterward. Use ![Sync library](/icons/refresh-cw.svg) when you want an immediate full scan.

Opening a library shows watcher health, the indexed count, scan history, and its catalog. A scan may finish with warnings even when most media was indexed successfully. Review the library diagnostics before changing a schedule that depends on missing items.

After scanning, the catalog displays the indexed media with its posters and titles. This example shows a populated library with 17 movies and a completed scan.

![Evening Cinema library with 17 indexed movies, poster artwork, and scan status](/screenshots/library-catalog.png)

Library settings can change the display name or source path. A path change is staged for safety when it could make many existing items appear to have disappeared.
