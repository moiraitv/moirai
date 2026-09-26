# Changelog

## 0.4.0 - 2026-09-25

### New

- **Sequence** programs now offer **Ordered**, **Shuffled blocks**, **Shuffled allocations**, and **Balanced rotation** ordering. Shuffle whole steps, mix their selections while preserving each step's count, or spread selections proportionally while avoiding consecutive turns from the same step when possible. Shuffle modes support an optional **Stable seed**.
- Sequence editors and inspectors include a **Guide preview** of a sample day, with colored selections and a numbered step legend. Scroll through the day in a four-hour view; editor previews update as the sequence changes without advancing channel playback progress.
- **Primary** genre filters are available in the library, Quick Setup, and program library queries alongside **Has** and **Doesn’t Have** rules. The first valid genre in source metadata is primary unless an NFO `<genre primary="true">` marker overrides it.
- The user guide includes a section of **Example schedules** for movie shuffles, genre double features, sitcom rotations, cartoon lineups, and weekend variations.

### Improvements

- Genre filter controls keep names aligned and shorten large counts for a more compact layout. Accessible labels retain exact totals.
- **Sport** and **Sports** now share one **Sports** filter choice. Existing library indexes refresh on their next synchronization; source metadata keeps its original spelling.

## 0.3.0 - 2026-09-23

### New

- **Programs** now uses a compact, searchable list with type, subtype, and usage filters, sorting, media previews, and indexed item counts. Select a program to open its inspector beside the list on desktop or in a drawer on smaller screens. 
  - Program inspectors show type-specific definitions, source libraries, availability, and **Used by** references.
  - Sequence programs show media samples from their sources. **Sequence Configuration** lists numbered source blocks with thumbnails, configured item counts, and an **items per cycle** total. Select a block to inspect that source program.
- Channels have an **On/Off** switch to control publication in M3U and XMLTV. Turning a channel off keeps its settings and schedule available in Moirai.
- **Regenerate schedule** rebuilds one channel from scratch while preserving its templates and settings. It resets selection progress and scheduling history, uses fresh randomness unless an explicit seed is set, and restarts active playback after confirmation.

### Improvements

- Channel saves, schedule previews, guide generation, and XMLTV rendering do more work in the background so the interface remains responsive with large libraries and lineups.
- The guide keeps existing listings visible during refresh, shows **Preparing guide…** for newly assigned channels, and offers **Retry** for persistent failures. It refreshes when generation finishes or a connection is restored.
- The bundled ErsatzTV-Next engine has been updated with improvements for rotated video, AAC surround audio, AMD tone mapping and MPEG-2 decoding, and overlay rendering.

### Changes

- The guide and XMLTV feed now default to seven local days, with one extra day generated internally. Set `MOIRAI_GUIDE_DAYS` from `1` to `14` to adjust the horizon and its processing cost. Existing generated programming ages out naturally when the horizon is shortened.
- Production and Docker builds now check dependencies for known vulnerabilities and stop on any reported severity or an unsuccessful audit request. The vulnerable Sharp image-processing dependency has been updated while preserving Intel Mac embedding support.
- The updated playback engine uses a newer playout format. When rolling back, stop playback workers and regenerate playout with the restored application before tuning channels.

### Fixes

- Remounting a network share no longer invalidates unchanged media-probe and subtitle caches solely because filesystem device or inode identifiers changed. Existing cache keys refresh once after upgrading; previously ignored scan findings may need to be reviewed again.
- Retrying a failed logo or fallback upload after creating a channel updates the saved channel instead of creating another one. The editor preserves the remaining draft and identifies the unfinished asset.

## 0.2.0 - 2026-09-21

### New

- **Similar Items** programs find media related to a hand-picked program. 
- **Theme** programs find media matching a description. Both run locally with a bundled model and prepare matches in the background as the schedule needs them.
- Similar Items and Theme editors have match previews, library filters, quantity, **Cohesion / Variety**, preferences, and exclusions.
- **Guide Templates** customize XMLTV channel and program listings with Liquid templating engine, a live preview, a global default, and per-channel overrides. Duplicate the built-in **Standard XMLTV** template to get started.
- Optional **Duration → From / To** filters limit playback length in the library, Quick Setup, and program queries.
- Library health reports audio/video track duration differences. **Ignore issue** hides supported findings until the relevant files change; **Suppressed issues** lets you review them and restore manually ignored findings.

### Improvements

- The guide scrolls more smoothly with large channel lineups and keeps its week controls and time ruler visible. It shows about two hours on phones and four on tablets or larger.
- Guide listing appearance has been updated to use template titles and subtitles, thumbnails, and dimmed background artwork.
- Library scans do less repeated database and search-index work. Large program lists and log views are more responsive.
- Libraries show scan status in the main navigation. **Last scan** opens scan history, and **Show all issues** opens the full list of findings.
- Program colors expanded to a palette of 32 with darker gradients and more readable text. Opening an editor preserves the Programs list's filters and scroll position.
- Posters, landscape images, and fanart are now imported and used by the UI.

### Changes

- Audio/video duration warnings are suppressed when audio is no more than 5% shorter or 30 seconds longer than the video. Larger differences can also be auto-suppressed when inspection confirms a short silent ending stays at least 90% black like most foreign audio credit sequences.
- The bundled dead-air fallback loop has been updated to be smaller and better visually.
- The built-in XMLTV template labels movies as **Movie** and episodes as **Series** so clients can classify them correctly in automatic categories.

### Fixes

- Playback and scheduling use measured video-track durations instead of container or audio runtimes. Cached measurements are refreshed on the next scan; embedded cover images no longer count as video tracks.
- Channel editor links and scheduling diagnostic controls resolve correctly when their data loads overlap.

## 0.1.1 - 2026-09-17

### New

- After an upgrade with database migrations, Moirai now updates the database in the background and shows a public “Updating the database” page until the application is ready. Health checks stay up so Docker and reverse proxies do not take the container out of service during that wait.
- Errors including 404s now show an appropriate error page.
- Library media cards have a **+** control to add that one item or group to a program without entering multi-selection mode.
- **View Current Scores** on Settings opens a ranked list of learned viewing preferences used by the "Weighted Random" ordering mode, with artwork, show/episode or artist/album labels, plot hover, title search, and **Clear History** as a two-click control at the bottom of the dialog.

### Improvements

- Large-library search is much faster (full-text index with a fallback for substring matches) and search results are flattened so matching episodes are not hidden inside groups. Building this index may cause a delay after updating from 0.1.0.
- The program guide loads today first in order to become usable sooner, then the rest of the week, and only draws programs that are on screen, so the page stays responsive with large lineups.
- Timeline generation is faster and more careful about occupancy around local midnight and DST.
- **Used by** on programs, templates, encoding profiles, and credit templates now lives in the editor title bar, with a more appropriate icon and a live count. Media item pages still use the right-edge tab with the TV icon.
- Quick Setup has been moved just under Status in the navigation and is highlighted when there are no channels yet.
- Built-in encoding presets now show the read-only notice above the fields. Program **Browse** is now an outlined control.

### Changes

- Status, the dashboard, and Settings describe playback capacity as **streams** rather than channels.
- Quick Setup no longer fails when a program name is already in use; it adds a number such as `(2)` instead. Create errors show in the footer.
- Channel branding on Quick Setup confirmation overlays **Channel ready** instead of shifting the layout.
- Ready health only treats the process as unusable when the database or playback engine is down. Temporary scheduling unavailability no longer takes the container out of rotation.

### Fixes

- Midnight date rollover no longer marks the service unready or drops still-playing guide and XMLTV items that started the previous evening.
- Channel numbers work in browsers that use Unicode Sets HTML patterns.
