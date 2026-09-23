---
id: playback.guide
title: Guide and IPTV clients
description: Copy Moirai's playlist and guide addresses into a compatible player.
contextual: true
---

# ![](/icons/calendar-days.svg) Guide and IPTV clients

The **![](/icons/calendar-days.svg) Guide** page shows the committed rolling lineup and the addresses an IPTV client needs. Listing titles and optional subtitles come from each channel’s [guide template](/playback/guide-templates), or from the default template when the channel does not choose one.

On Guide and Channels, the guide list expands to show all channels and scrolls vertically with the page. Guide shows approximately two hours on phones, four hours on tablets, and four hours on desktops; Channels shows six hours. Scroll horizontally to browse later programming. On Guide, the week controls and time ruler stay visible while you scroll down the channels. Select **Today** to return to the current week, centering the now line within the visible timeline.

The guide and XMLTV feed cover seven local calendar days by default, including today. Set `MOIRAI_GUIDE_DAYS` to a value from `1` to `14` and restart Moirai to change that horizon. A shorter horizon reduces guide size and future scheduling work. Moirai generates one extra day internally to keep listings available across midnight. With a one-day guide, tomorrow’s private playback file is also prepared in advance so playback can continue across midnight. Reducing the horizon limits the published guide immediately; existing generated programming ages out without resetting selection progress. The in-app guide displays up to seven days at a time and lets you move forward when more days are configured.

A newly assigned channel may show **Preparing guide…** until its committed programming is available. You can continue browsing other channels during that period. If anything fails, the message remains visible with a **Retry** action. The guide refreshes when generation completes and after a connection is restored. Reconnecting also reloads the configured horizon before requesting listings.

Hover over an individual media item, or focus it with the keyboard, to see its details in the same preview used on Programs. Click the item to open its full guide details.

![The electronic program guide and connection addresses](/screenshots/guide.png)

Use the M3U playlist address for channels and the XMLTV address for program listings. Some clients ask for both during setup; others can read the guide address embedded in the playlist. XMLTV title, description, and related fields come from the channel’s [guide template](/playback/guide-templates), or from the default template when the channel does not choose one.

The addresses use `MOIRAI_PUBLIC_URL`. If they contain `127.0.0.1` or `localhost`, a client on another device will try to connect to itself. Set the public URL to the reachable HTTP or HTTPS origin, restart Moirai, and copy the new addresses.

The guide contains committed programming rather than unsaved editor previews. A warning or incomplete range means one or more channel timelines could not be generated fully. Open the relevant channel schedule to inspect its preview and issues.

## Single-block listings

A template slot can show one guide listing, such as “Rock Music,” in place of its individual videos. Configure its title, description, and scheduled or drift-inclusive timing in [Templates](/scheduling/templates). These changes affect the Guide page and XMLTV only; playback continues unchanged.

![A single-block listing with its actual items in a 30-minute hover preview and matching range markers](/screenshots/guide-single-block.png)

Hover over a guide block to see a 30-minute zoomed timeline of its actual items, centered near the time under the pointer. Move along the block to inspect another time. The preview follows the pointer while staying within the screen. Keyboard focus centers the crop on the block’s midpoint; tapping uses the tapped time.
