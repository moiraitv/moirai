---
id: getting-started.first-channel
title: Create your first channel
description: Follow the shortest path from a media folder to a playable IPTV channel.
contextual: false
---

# Create your first channel

This walkthrough uses the full editors available in the current released interface.

1. Open **Libraries**, select **Add Library**, give the source a recognizable name, and enter its path
   inside the Moirai container. Choose **Add and Scan**.
2. Wait for the library to report indexed items. Open it and make sure titles and durations look
   sensible.
3. Open **Scheduling → Programs** and create a program. A sequence program is a straightforward first
   choice: select the items you want and arrange their order.
4. Open **Scheduling → Templates**. Create a template, add a slot, and assign the program. Use filler
   behavior if the selected media may not fill the entire slot.
5. Open **Channels** and create the channel viewers will receive. Choose its channel number, name, and
   playback profile.
6. Open **Scheduling → Channel Schedules**, choose the channel, and assign the template as its base
   schedule. Review the preview and save it.
7. Open **Guide**. When the rolling guide is healthy, copy the playlist and XMLTV addresses into your
   IPTV client.

The dashboard reports whether playback is ready. If the guide contains gaps or playback is degraded,
start with [Troubleshooting](/operations/troubleshooting).
