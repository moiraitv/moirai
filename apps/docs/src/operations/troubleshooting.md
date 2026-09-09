---
id: operations.troubleshooting
title: Troubleshooting
description: Work from visible symptoms to the most likely corrective action.
contextual: true
---

# Troubleshooting

## Playback is degraded

Open the dashboard and inspect the playback status. Confirm the channel worker is present in a custom installation. For Docker hardware acceleration, confirm `/dev/dri` is passed through and that the container user belongs to the numeric groups owning the video and render devices. Switch the channel to automatic or software processing to isolate a device problem.

## An IPTV client cannot connect

Open **![](/icons/calendar-days.svg) Guide** and inspect the published addresses. Replace a loopback `MOIRAI_PUBLIC_URL` with an origin reachable from the client. Check firewall and reverse-proxy rules, then try the M3U URL in a browser on the client device.

## Media disappeared

Check that the source is mounted and readable before confirming removals. Restore the mount and scan again. Use reconciliation only when the files were deliberately removed or moved.

## The guide has gaps or warnings

Open the channel schedule and generate a preview. Check program eligibility, media duration, template boundaries, and filler. A fallback video keeps the stream valid but does not make the schedule warning go away.

## A change is not visible yet

Saved schedule changes normally begin at the next local midnight. Use **Apply after current item** when available. Refresh the page after the server reconnects, and check Logs if generation failed.
