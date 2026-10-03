---
id: playback.settings
title: Settings
description: Configure AI content selection, playback, filler, and viewing preferences.
contextual: true
---

# Settings

Open **Settings** to set the maximum number of active channel sessions, select a global fallback filler, control preferences that affect future scheduling, and connect an AI provider. The channel playlist and XMLTV guide addresses are available on **Guide**.

![Moirai settings](/screenshots/settings.png)

In **AI provider**, choose a provider and enter its API key. The recommended model is used by default, but **Advanced** lets you set a different model, enable compatible web research, and choose its time limit. Choose **Custom** to enter your own endpoint and format. Saving checks the connection once. See [AI content selection](/operations/configuration) for details.

In **Filler Settings**, **Warn when filler supplies less than (%)** is a slider that controls budget-shortfall warnings for pre-roll, mid-roll, and post-roll. The default is **80%**: a 120-second break warns only if less than 96 seconds plays. Time budgets compare playback duration; quantity budgets compare clips played, using the chosen quantity for random budgets. A zero-sized budget never warns. Use **0** to turn off these warnings or **100** to warn about any incomplete budget. Use **Save Filler Settings** to apply the slider and any fallback video changes together. **Reset** discards both drafts after a second click. Changes apply to new previews and newly generated schedules; existing warnings remain until their coverage is replaced. Missing sources, invalid media, and dead-air warnings remain independent.

The global fallback is used when a channel has no more specific filler and its committed schedule has a gap. The bundled fallback is always available. A custom video must be at least 30 seconds long and readable inside the running container. It should be suitable for looping or truncation.

Viewing preferences let Moirai account for what anonymous viewers choose while building future selections. Choose **View Current Scores** to inspect the ranked list with artwork and show, episode, artist, or album labels. Hover a row for the same plot preview used on catalog cards. **Clear History** is at the bottom of that dialog and asks for a second click before it permanently removes learned preferences. Clearing history affects future decisions only; it does not rewrite the committed guide immediately.

Changing a setting does not guarantee existing playback sessions restart. Use the dashboard's restart action when an active channel needs to pick up a compatible playback change immediately.
