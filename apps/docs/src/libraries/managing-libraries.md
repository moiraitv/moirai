---
id: libraries.manage
title: Libraries and scanning
description: Add media sources and understand what happens during a scan.
contextual: true
---

# Libraries and scanning

A library tells Moirai where media lives. Open **Libraries** to add a source, see its current health,
or start a synchronization.

![The libraries page before a source is added](/screenshots/libraries.png)

Use the path as Moirai sees it. In Docker this is normally a mounted path such as `/media/movies`.
Moirai reads video files and Kodi-compatible NFO sidecars, probes technical playback facts, and keeps
an index in its database. The original media remains the source of truth.

The first scan can take time for a large collection. A source watcher handles ordinary additions and
changes afterward. Use **Sync library** when you want an immediate full comparison.

Opening a library shows watcher health, the indexed count, scan history, and its catalog. A scan may
finish with warnings even when most media was indexed successfully. Review the library diagnostics
before changing a schedule that depends on missing items.

Library settings can change the display name or source path. A path change is staged for safety when
it could make many existing items appear to have disappeared.
