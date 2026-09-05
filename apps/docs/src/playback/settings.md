---
id: playback.settings
title: Playback settings
description: Configure service-wide playback, filler, and viewing preferences.
contextual: true
---

# Playback settings

Open **Settings** to copy service addresses, select a global fallback filler, and control preferences
that affect future scheduling.

![Moirai playback settings](/screenshots/settings.png)

The global fallback is used when a channel has no more specific filler and its committed schedule has
a gap. The bundled fallback is always available. A custom video must be readable inside the running
container and should be suitable for looping or truncation.

Viewing preferences let Moirai account for what anonymous viewers choose while building future
selections. Clearing that history affects future decisions only; it does not rewrite the committed
guide immediately.

Changing a setting does not guarantee existing playback sessions restart. Use the dashboard's
restart action when an active channel needs to pick up a compatible playback change immediately.
