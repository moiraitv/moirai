---
id: channels.manage
title: Channels
description: Configure the identity and playback profile viewers receive.
contextual: true
---

# Channels

A channel combines a viewer-facing number and name with playback settings. Open **Channels** to create
or edit one and to review its resolved seven-day timeline.

![The channels page](/screenshots/channels.png)

Channel numbers must be distinct. Choose stable numbers because IPTV applications may use them when
organizing favorites. A logo is optional and is served through Moirai when present.

The playback profile controls normalization and hardware acceleration. **Automatic** is the safest
starting point because Moirai can choose a supported path. An explicit acceleration target is useful
only when the host device is correctly passed into the container.

A channel-specific fallback filler can override the global fallback when scheduling leaves a gap.
Fallback keeps playback output valid, but it does not hide guide warnings: fix recurring gaps in the
program or template when possible.
