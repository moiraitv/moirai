# Layout recipes

[Handbook](../README.md) · [Behavior](behavior.md)

All examples use fictional local content and the shared token stylesheet. They follow current source-owned compositions with explicit shared-style unifications, rather than redesign proposals. See [current UI](current-ui.md) for source owners and separate stored application captures. Open the served gallery links from the handbook
for working native controls; the PNGs are reference captures.

| Layout            | Composition and decision rules                                                                                                                                                                                                                                                     | Reference                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status            | Source shell → active channels/now-playing → Libraries/Channels/IPTV metrics → library health → data conflicts. Separate from Logs.                                                                                                                                                | [1440×1000](../images/layouts/status.png)                                                                                                                                              |
| Logs              | Source shell → search/level/live-refresh/download controls → structured entries → retained files. Separate from Status.                                                                                                                                                            | [1440×1000](../images/layouts/logs.png)                                                                                                                                                |
| Program catalog   | Current shell → Programs header → search/type/subtype/usage/sort → source-sized overview rows → 390px inspector when selected. The live source virtualizes this list; it does not paginate it.                                                                                     | [1440×1000](../images/layouts/catalog.png)                                                                                                                                             |
| Media library     | Shell → library title/help and sync/settings/search → five-section status bar → alphabet navigation, sort menu, filter icon, bulk-select icon → artwork grid → fixed pagination footer. Normal cards show +; bulk mode exposes count, Add Selected, Add All and Select/Clear Page. | [1440×1000](../images/layouts/library.png), [expanded](../images/layouts/library-expanded.png), [390px](../images/layouts/library-390.png), [320px](../images/layouts/library-320.png) |
| Channel Schedules | Current shell → Channel Schedules header → channel search/count → channel-owned base and conditional stacks, Next 24h status and Edit Schedule access. The Guide remains a separate view.                                                                                          | [1440×1000](../images/layouts/schedules.png)                                                                                                                                           |
| Resource editor   | Bounded surface with persistent header, grouped scrolling body and persistent footer. Number / Name / Group, schedule access and logo precede feature-owned encoding, subtitle, guide-template and fallback sections.                                                              | [1440×1000](../images/layouts/editor.png), [scrolled body](../images/layouts/editor-scrolled.png)                                                                                      |
| Settings          | Page header → Playback / AI / Backups tabs → focused settings with saved-value disclosures and one persistent Save/Reset footer per tab. Playback readiness stays compact; warnings remain visible. Invalid input keeps Save disabled.                                             | [1440×1000](../images/layouts/settings.png)                                                                                                                                            |
| Mobile catalog    | Brand/menu header → current Programs heading → current filters → compact version of the Program overview list, preserving identity and actions.                                                                                                                                    | [390×844](../images/layouts/mobile-catalog.png), [navigation drawer](../images/layouts/navigation-390.png)                                                                             |
| Mobile editor     | 8px outer gutter → persistent title/close → one-column scrolling fields → Delete row then Reset/Save row. Never put the action bar inside body scrolling.                                                                                                                          | [390×844](../images/layouts/mobile-editor.png), [scrolled body](../images/layouts/mobile-editor-scrolled.png)                                                                          |

Settings variants: [AI](../images/layouts/settings-ai.png), [Backups](../images/layouts/settings-backups.png), [expanded disclosure](../images/layouts/settings-disclosure.png), [390px](../images/layouts/settings-390.png), and [320px](../images/layouts/settings-320.png), [390px expanded](../images/layouts/settings-390-expanded.png), and [320px expanded](../images/layouts/settings-320-expanded.png).

## Creating a new screen

1. Identify the task and resource, primary action, loading/error ownership and whether there is a
   saveable draft. Choose the closest recipe above before creating new structure.
2. Use the shared shell, heading hierarchy and responsive insets. Pick a table for comparison, cards
   for content recognition, and an inspector only when preserving collection context helps.
3. Compose existing component families. Use semantic tokens, standard type roles and spacing steps.
   Document any genuine exception alongside the component rather than inventing an inline value.
4. Specify first-load, loaded-empty, populated and failed states. Define the exact scope of selection,
   validation, saving, deletion and dismissal. Keep user-authored ordering and spelling.
5. Check keyboard order, control names, visible focus, contrast, 320px width, 200% text scaling,
   safe areas, long content, body scrolling and reduced motion.
6. Add a representative specimen if the screen introduces a reusable pattern. Capture it with the
   existing command, inspect it at actual size, and update the relevant guidance and links together.

## What to avoid

Do not make every section a raised card, put several primary actions in one task area, replace
visible labels with placeholders, encode status only through color, use white small text on mint,
show zero counts while loading, dismiss errors on a timer, or place save controls beyond a long
scrolling body. Avoid oversized decorative headings on dense operational screens and tiny controls
on touch layouts.

Library cards preserve both modes: [normal browsing](../images/layouts/library.png) has a top-right + for single-item Program addition; [bulk selection](../images/layouts/library-bulk.png) replaces it with a checkbox and a count/action bar. The working reference starts in normal mode.

Preserve title-adjacent question-mark help on Programs, Libraries, Channel Schedules and channel editors, including mobile variants. Settings keeps card-level help and no page-level help. The local reference drawer uses copied bundled topic HTML and local full-chapter snapshots with unchanged review state.

The library status bar keeps Watcher / Scan status / Indexed / Last scan / Last change, their source icons and semantic colors. Last scan is a button with a trailing chevron opening scan history. At ≤1220px the five sections scroll horizontally inside their surface, matching the current source; do not turn them into a different dashboard. The alphabet strip moves below sort/filter/selection controls. The bottom footer shows range, connected previous/page/next controls and page size (100); its mobile variant stacks the range and page controls and hides page size. The eight-item fixture has one page, so navigation arrows are disabled.

[Library help](../images/layouts/library-help.png) · [Sort menu](../images/layouts/library-sort-open.png) · [Scan history](../images/layouts/library-scan-history.png)

Expanded narrow library references: [390px](../images/layouts/library-390-expanded.png) · [320px](../images/layouts/library-320-expanded.png) · [390px bulk](../images/layouts/library-bulk-390-expanded.png) · [320px bulk](../images/layouts/library-bulk-320-expanded.png). These expand canvas height to show all fixture content with pagination at the bottom; the adjacent viewport images remain 844px tall.

Additional source-owned compositions: [committed Guide](../images/layouts/guide.png) and
[Sequence Program editor](../images/layouts/program-editor.png). The latter keeps the fixed type rail,
counted source steps, repeat, conditional ordering seed, single-track guide sample and inherited
preferences. Mobile navigation and inspection are separate: [navigation](../images/layouts/navigation-390.png),
[Program inspection](../images/layouts/inspector-390.png).

Guide feed: keep the compact Playlist and guide URLs bar. Right-aligned icon buttons labeled M3U
and XMLTV copy their complete URL on click/tap, with the shared dismissible confirmation. On failure,
show the copyable URL and persistent error in the bar. Do not put URL fields below it.

Playback readiness groups the badge, count and help together, with Refresh Status and Engine details
at the right. Engine details opens the [floating popup](../images/layouts/settings-engine-open.png);
Escape/outside interaction dismisses it without reflowing the status card.
