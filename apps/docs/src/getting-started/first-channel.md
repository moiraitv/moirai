---
id: getting-started.first-channel
title: Create your first channel
description: Follow the shortest path from a media folder to a playable IPTV channel.
contextual: true
---

# Create your first channel

## Start with Quick Setup

Open **Quick Setup** from navigation or the dashboard. Choose **Movie Channel**, **Show Channel**, or
**Music Video Channel** to open the four-step wizard.

1. **Choose a media library.** Reuse a compatible library or choose **Create new**, enter a name and
   the folder path as Moirai sees it, then select **Create and Continue**. Scanning starts immediately.
2. **Choose the programming.** Use a dynamic library query to include matching media as the library
   changes, or select specific items. Show channels can also select shows or seasons. Configure filters,
   ordering, an optional item limit, and playback selection behavior; inspect the matching media sample.
3. **Name and brand the channel.** Set a distinct channel number, name, optional group, and optional
   logo. The logo keeps its full image and transparency. Playback starts with automatic defaults.
4. **Review Setup.** Inspect the library, programming, channel, and sample day, then select
   **Create Channel**. Open the schedule from the completion screen or visit **Guide** for IPTV addresses.

![Quick Setup programming with an indexed movie library](/screenshots/quick-setup.png)

The sample day uses the server timezone. It is illustrative: indexing and randomized selection can
change the result. A preview error does not prevent an otherwise valid setup. A dynamic query can be
saved while scanning is still underway, but playback needs usable indexed media.

Quick Setup creates a linked program, daily template, channel, and base schedule together. A library
created earlier in the wizard remains and continues scanning if you cancel. If an optional logo upload
fails, the channel is still created; retry the upload from the completion screen.

## Use the full editors

For finer control over individual resources or an existing setup, follow these steps.

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
