---
id: operations.troubleshooting
title: Troubleshooting
description: Work from visible symptoms to the most likely corrective action.
contextual: true
---

# Troubleshooting

## Playback is degraded

Open the dashboard and inspect the playback status. Confirm the channel worker is present in a custom installation. For Docker hardware acceleration, confirm `/dev/dri` is passed through and that the container user belongs to the numeric groups owning the video and render devices. Switch the channel to automatic or software processing to isolate a device problem.

## Diagnose black or silent playback

Check Logs for the failed item and its scheduled time. For temporary on-screen diagnostics, set `MOIRAI_DEBUG=true` in the server environment and restart Moirai. When the playback engine cannot select or play an item, its fallback can show the reason to viewers, including file paths and FFmpeg error details. Set `MOIRAI_DEBUG=false` and restart to turn these cards off. This setting is off by default and is independent of `MOIRAI_LOG_LEVEL`.

Debug cards do not replace your configured fallback video for schedule gaps. They appear only when the engine itself substitutes fallback after a selection or playback failure, or an uncovered interval.

## An IPTV client cannot connect

Open **![](/icons/calendar-days.svg) Guide** and inspect the published addresses. Replace a loopback `MOIRAI_PUBLIC_URL` with an origin reachable from the client. Check firewall and reverse-proxy rules, then try the M3U URL in a browser on the client device.

## Media disappeared

Check that the source is mounted and readable before confirming removals. Restore the mount and scan again. Use reconciliation only when the files were deliberately removed or moved.

## The guide has gaps or warnings

Open the channel schedule and generate a preview. Check program eligibility, media duration, template boundaries, and filler. A fallback video keeps the stream valid but does not make the schedule warning go away.

## The browser shows “Updating the database”

The first start after an upgrade can take several minutes while Moirai updates its database. Leave that page open; it reloads when the application is ready. This screen does not require a sign-in. If it stays for much longer than a typical upgrade or reports a failure, check container logs and restart Moirai.

## A change is not visible yet

Saved schedule changes normally begin at the next local midnight. Use **Apply after current item** when available. Refresh the page after the server reconnects, and check Logs if generation failed.
