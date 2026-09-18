# Changelog

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
