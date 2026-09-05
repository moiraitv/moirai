---
id: playback.guide
title: Guide and IPTV clients
description: Copy Moirai's playlist and guide addresses into a compatible player.
contextual: true
---

# Guide and IPTV clients

The **Guide** page shows the committed rolling lineup and the addresses an IPTV client needs.

![The electronic program guide and connection addresses](/screenshots/guide.png)

Use the M3U playlist address for channels and the XMLTV address for program listings. Some clients ask
for both during setup; others can read the guide address embedded in the playlist.

The addresses use `MOIRAI_PUBLIC_URL`. If they contain `127.0.0.1` or `localhost`, a client on another
device will try to connect to itself. Set the public URL to the reachable HTTP or HTTPS origin, restart
Moirai, and copy the new addresses.

The guide contains committed programming rather than unsaved editor previews. A warning or incomplete
range means one or more channel timelines could not be generated fully. Open the relevant channel
schedule to inspect its preview and issues.
