---
id: getting-started.first-channel
title: Create your first channel
description: Follow the shortest path from a media folder to a playable IPTV channel.
contextual: true
---

# Create your first channel

You can use **Quick Setup** to combine several steps into one guided workflow and create simple channels more quickly, or complete each step independently with the full editors for more control over media selection, programming, and scheduling. Both approaches are described below, and you can use the full editors to refine a channel created with Quick Setup later.

## Start with Quick Setup

Open **Quick Setup** from navigation or the dashboard. Choose **Movie Channel**, **Show Channel**, or **Music Video Channel** to open the four-step wizard.

1. **Choose a media library.** Reuse a compatible library or choose **Create new**, enter a name and the folder path as Moirai sees it, then select **Create and Continue**. Scanning starts immediately.
2. **Choose the programming.** Use a dynamic library query to include matching media as the library changes, or select specific items. Show channels can also select shows or seasons. Configure filters, ordering, an optional item limit, and playback selection behavior; then preview the matching media sample.
3. **Name and brand the channel.** Set a distinct channel number, name, optional group, and optional logo. As you type a number, similarly-numbered channels appear so you can see what may be already used. The Group field suggests existing groups, the logo keeps its full image and transparency, and playback starts with automatic defaults.
4. **Review Setup.** Inspect the library, programming, channel, and sample day, then select **Create Channel**. Open the schedule from the completion screen or visit **![](/icons/calendar-days.svg) Guide** for IPTV addresses.

![Quick Setup programming with an indexed movie library](/screenshots/quick-setup.png)

The sample day uses the server timezone. It is illustrative: indexing and randomized selection can change the result. A preview error does not prevent an otherwise valid setup. A dynamic query can be saved while scanning is still underway, but playback needs usable indexed media.

Quick Setup creates a linked ![](/icons/list-video.svg) Program, ![](/icons/calendar-range.svg) Template, ![](/icons/tv-minimal.svg) Channel, and ![](/icons/tv-minimal-play.svg) Channel Schedule together. A ![](/icons/library.svg) Library created earlier in the wizard remains and continues scanning if you cancel. If an optional logo upload fails, the channel is still created; retry the upload from the completion screen.

## Use the full editors

For finer control over individual resources or an existing setup, follow these steps.

1. Open **![](/icons/library.svg) Libraries**, select **Add Library**, give the source a recognizable name, and enter its path inside the Moirai container. Choose **Add and Scan**.

   ![Libraries page with the Add Library action](/screenshots/libraries.png)

2. Wait for the library to report indexed items. Open it and make sure titles and durations look sensible.

   ![Evening Cinema catalog after a completed scan, showing 17 indexed movies](/screenshots/library-catalog.png)

3. Open **Scheduling → Programs** and create a program. A sequence program is a straightforward first choice: select the items you want and arrange their order.

   ![Programs page with New Program and an existing media selection](/screenshots/programs.png)

4. Open **Scheduling → Templates**. Create a template, add a slot, and assign the program. Use filler behavior if the selected media may not fill the entire slot.

   ![Templates page with New Template and a one-slot daily template](/screenshots/templates.png)

5. Open **![](/icons/tv-minimal.svg) Channels** and create the channel viewers will receive. Choose its channel number, name, and playback profile.

   ![Channels page with New Channel and Moonrise Classics awaiting a schedule](/screenshots/channels.png)

6. Open **Scheduling → Channel Schedules**, choose the channel, and assign the template as its base schedule. Review the preview and save it.

   ![Channel Schedule editor with a base Template and a preview warning about a playback gap](/screenshots/channel-schedules.png)

   This example preview shows a gap. Review warnings and adjust the programming or fallback behavior before relying on the lineup.

7. Open **![](/icons/calendar-days.svg) Guide**. When the rolling guide is healthy, copy the playlist and XMLTV addresses into your IPTV client.

   ![Guide page showing playlist and XMLTV addresses with Copy URL buttons](/screenshots/guide.png)

The dashboard reports whether playback is ready. If the guide contains gaps or playback is degraded, start with [Troubleshooting](/operations/troubleshooting).
