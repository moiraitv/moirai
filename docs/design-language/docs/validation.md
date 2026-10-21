# Validation evidence and limits

[Handbook](../README.md) · [Audit matrix](audit.md) · [Commands](iteration.md) · [Capture environment](../images/captures.json)

## Reference baseline audit (historical)

These results describe the reference-only audit before application adoption. Current production and final consistency checks are recorded in [application adoption](application-adoption.md).

Validated on 2026-10-19 using Playwright Chromium 151.0.7922.34. The
[decision register](audit.md#deliberate-revisions-preserved) distinguishes explicit user revisions
from the application's source baseline. At that time the reversible 50% radius trial was active. The smaller 2/4/6/8px scale has since been adopted permanently in the base tokens; the two before images remain historical evidence.

- **27 standalone browser checks passed.** Coverage includes the actual shell destinations and
  independent group expansion, mobile navigation dismissal/focus, responsive Program inspection,
  source-shaped library controls and both card modes, menu dismissal, two-step cancellation and
  unchanged geometry, protected Channel/Sequence drafts, conditional subtitle/encoding/AI fields,
  source help topics and loading/failure/retry, local log filtering/details, and Guide detail focus. Review checks cover unclipped mint navigation summaries, account-footer
  framing, matching library-tool borders, separate Status/Logs routes, no-reflow Engine details
  popovers, feed clipboard actions, and restored Channel fieldsets/disclosures.
- **The isolated application comparison passed.** The real application ran against the existing
  documentation fixture and disposable database. Fresh evidence includes all Settings tabs, library
  states/filters/history, Program inspection, Content and Sequence editors, Channel fields/logo crop,
  scheduling, Guide, logs and mobile navigation. It lives separately under `images/source-audit/`.
  No user database was opened, documentation screenshot published, or review digest approved.
- **Coverage and local assets:** all 15 families have specifications and linked specimen images;
  all eleven layouts use the shared stylesheet. Local Markdown/image references resolve; all 103 token
  values match the generated table; tested stylesheet token references resolve. Local Inter and
  images load without browser errors, failed requests or external requests. Documentation-fixture
  artwork remains unchanged.
- **Responsive behavior:** declared desktop/mobile layouts have no document-level horizontal
  overflow. Checks cover 1440px, 390px and 320px, public media-density breakpoint boundaries, long
  Channel names, visible persistent editor actions, 44px mobile footer targets, and the desktop
  editor at 200% root text size. Wide carousels, status strips and timelines scroll locally.
- **Contrast and keyboard:** tested semantic text pairs meet 4.5:1 and essential control/focus pairs
  meet 3:1, including composited gradient endpoints. Disabled controls are excluded. Focus visibility,
  exclusive choices, tab navigation, native modal containment, dismissal/focus return, and reduced
  motion are exercised. These checks do not establish complete WCAG conformance.
- **Rendering:** current specimen boards, complete layouts, open states, narrow and expanded/scrolled
  variants were regenerated with software rendering and reviewed for artwork, missing glyphs,
  clipping, alignment and reachable actions. Expanded library and Settings captures increase canvas
  height so fixed pagination/actions appear at the bottom; separate viewport captures remain 844px.
  That capture manifest recorded environment, font digest and per-image hashes for 89 PNGs, including two historical radius comparisons. Current captures contain 87 active reference images; the historical comparisons are no longer regenerated.
- **Byte comparison:** a repeat `capture.mjs --check` matched the index, all 15 desktop component
  boards, tooltip and contextual-menu images before stopping at the loaded-help drawer image. That
  image differed in **three pixels by at most one channel level**, with unchanged dimensions. Exact byte
  reproducibility of the entire edition is not confirmed; later captures were not reached by that
  strict run. The command preserves references and writes the mismatch under
  `test-results/design-language/`.
- **Static checks:** targeted ESLint, Prettier, token generation and whitespace checks passed.
  At completion of the reference-only audit, production code, application interfaces, user-guide source/review state and the three exploratory concepts remained unchanged. Subsequent [application adoption](application-adoption.md) has its own production verification evidence.

## Prototype boundaries

The gallery exercises presentation and local interaction. Backend search/sorting/filter queries,
virtualization, scan/sync, AI generation, provider verification, backup/restore, image cropping,
schedule resolution and continuous playback/log updates remain application-owned. The controls,
fields and conditional rules document their source owners; no successful backend operation is
simulated. Guide dates, blocks, counts, reference usage and log rows are fictional local data.
The language lookup uses five local fixtures rather than the full application language dataset.

Help reproduces current bundled topic HTML, images, topic relationships, review warnings and local
chapter links. Those snapshots are a bounded copy, not a second documentation publisher. Destinations
outside the eleven representative layouts link to local reference guidance and retain their actual
application route in `data-app-path`; account/sign-out are presentation only. See the
[audit boundaries](audit.md#evidence-and-boundaries) for these deliberate prototype limits.

Browser checks use desktop Chromium with mobile viewport sizes. Physical touch hardware,
Safari/Firefox native-control differences, screen-reader output, high-contrast modes, full browser
zoom and a complete accessibility audit remain unverified. Production integration checks and user-guide updates are documented in [application adoption](application-adoption.md); they do not establish verification on additional browser engines or physical devices.
