---
id: settings.playback
title: Playback settings
description: Manage stream capacity, filler, viewing preferences, and playback status.
contextual: true
---

# Playback settings

Open **Settings → Playback** to adjust stream capacity, filler, and viewing preferences.

![Moirai playback settings](/screenshots/settings.png)

## Playback capacity {#playback-capacity}

Set **Maximum active channel sessions** to the number of channel streams that may play at once. The default is **4**, and the supported range is **1–32**. This does not directly control the number of simultaneously clients watching because an active stream will be shared by two or more clients watching the same channel.

## Filler {#filler}

**Warn when filler supplies less than (%)** is a slider that controls budget-shortfall warnings for pre-roll, mid-roll, and post-roll. The default is **80%** (e.g., a 120-second break warns only if less than 96 seconds plays). Time budgets compare playback duration; quantity budgets compare clips played, using the chosen quantity for random budgets. A zero-sized budget never warns. Use **0** to turn off these warnings or **100** to warn about any incomplete budget.

Expand **Global fallback filler** to preview or replace the video. The global fallback is used when a channel has no more specific filler and its committed schedule has a gap. The bundled fallback is always available. A custom video must be at least 30 seconds long and readable inside the running container and should be suitable for looping or truncation.

## Viewing preferences {#viewing-preferences}

Viewing preferences let Moirai account for what viewers choose while building future selections. Choose **View Current Scores** to inspect the ranked list with artwork and show, episode, artist, or album labels. Hover a row for the same plot preview used on catalog cards. **Clear History** is at the bottom of that dialog and asks for a second click before it permanently removes learned preferences. Clearing history affects future decisions only; it does not rewrite the committed guide immediately.

## Playback status {#playback-status}

Playback readiness and active stream counts appear in a compact status strip. Use **Refresh Status** to check again, or select **Engine details** to inspect the ErsatzTV-next version and revision in use.
