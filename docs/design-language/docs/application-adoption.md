# Application adoption

[Handbook](../README.md) · [Current UI mapping](current-ui.md) · [Reviewed decisions](audit.md)

The application now owns a production implementation of the reviewed design language. The standalone gallery remains a reference, outside application builds and the Docker context. Its fixture content, exploratory concepts, native demo dialogs, and simulated data are not production dependencies or product requirements.

## Runtime ownership

`apps/web/src/styles/_tokens.scss` mirrors the guide's semantic tokens. Existing feature names (`--bg`, `--panel`, `--accent`, `--line`, `--muted`, and related names) alias those roles, so feature styles use the same palette. Standard controls use `--control-height`: 42px for fine pointers, 44px for coarse pointers or phone widths up to 600px. Feature-owned paired fields use that token so explicit sizing cannot shrink their touch targets. Production bundles its own licensed Inter variable font under `apps/web/src/assets/fonts/`; the Inter license is also distributed at `/licenses/Inter-OFL.txt`. No font or asset is loaded from this documentation tree. Lucide remains the existing icon provider.

Primary actions use dedicated green fills (`--color-primary`, `--color-primary-hover`, `--color-primary-pressed`) with white `--color-on-primary` labels and icons. These roles are independent of the bright mint accent used by navigation, focus, switches and selection markers. The shared subtle button gradient and mint border provide the reviewed finish; all three action fills meet AA contrast with white text, including their gradient endpoints.

The permanent corner scale is 2/4/6/8px for small/control/panel/dialog corners in both production Sass and the reference stylesheet. The former trial overrides have been removed; the base tokens now own these values. Circular artwork, switches, and status dots retain their geometry. No stored setting or migration is involved.

The [motion standard](motion.md) defines timing, layout, accessibility and verification requirements. Compact disclosures now use the shared `FormDisclosure` plain presentation for warning help, hardware diagnostics, Program browsing and filters, credit-template metadata/output, Quick Setup warnings, Guide break details, and Status error details. AI Advanced uses the same component with a right-handle header matching Automatic Backup. These disclosures retain drafts and controlled open state, move affected siblings with the existing transition, restore focus on collapse, and skip motion when reduced motion is requested.

Shared structure, actions and overlay styling belong to the foundation partial. Feature-specific rules remain in their owning partials; responsive adaptations remain in the responsive partial. Preserve semantic artwork masks, selection indicators, warning patterns, and timeline geometry when adjusting visual finishes.

Settings uses section permalinks at `/settings/playback`, `/settings/ai`, and `/settings/backups`. The legacy `/settings?tab=…` addresses redirect without losing unrelated query values or fragments. Panels stay mounted across section links and history changes, preserving independent drafts and failures. Links support opening a section in a new browser tab while retaining the existing keyboard tab interaction.

## Contextual-help alignment

Page titles, resource-editor titles and Settings card titles share the foundation heading-row rule: 8px gap, centered alignment, margin-free headings, and the same compact 24px help control with its 20px icon and extended hit target. Library uses the shared page row; media-detail exterior spacing belongs to its containing row. Backup subtitle spacing no longer shifts its heading, and playback-status help uses the same gap. Topic ownership, independent disclosure controls, focus restoration and draft protection are unchanged.

The application browser check passed 36 page/editor scenarios at each of 1440px, 390px and 320px, including wrapped titles, Quick Setup and help focus return. The dedicated backup check also passed all three heading pairs at these widths. The standalone guide places Automatic Backup help in the title row beside its independent disclosure title and restores the source-owned Status/Logs help buttons.

All 78 application screenshots were refreshed after the finished build. The 23 capture workflows passed across the main run and a focused rerun: a timeline marker measured 1.999755859375px instead of exactly 2px, so its test now uses a 0.005px floating-point tolerance. The actual marker style is unchanged. The guide images and hashes were refreshed; documentation review approvals remain untouched.

## Route and component coverage

The application browser suite is `tests/e2e/design-language/application.spec.ts`. It uses the existing isolated documentation server and seed, not a user's database. Screenshots and traces are written under ignored `test-results/design-language-application/`. Reference images and historical source-audit evidence remain separate.

| Surface                                             | Applied rules / source owners                                                                                                  | Verification                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Authentication, setup, recovery, account and errors | Shared local font, controls, semantic feedback, panel finish and radii; authentication/account owners retain existing forms    | Authentication capture; account and error route captures; existing authentication/credential checks |
| Shell and mobile drawer                             | App shell, source navigation, small colored status summaries, original wordmark/tagline, hover, full-width footer rules        | All route captures; 390/320px navigation and existing shell tests                                   |
| Status and Logs                                     | Separate route owners; semantic states, data hierarchy and surface finish                                                      | Separate desktop/mobile route captures; existing playback/log tests                                 |
| Libraries and media details                         | Public tile sizing, artwork, carousels, both selection modes, source toolbar/status, inset carets and joined pagination        | Library route captures, filter assertions, existing library-navigation and media tests              |
| Library filters                                     | Counted fixed-width genre bar, gold star, segmented H/M/S bounds, paired ratings and Actor/Director                            | Production grouping and color assertions; existing duration-filter tests                            |
| Programs and inspector                              | Current overview, explicit inspection, compact previews, aligned controls and close placement                                  | Program route/breakpoint captures; existing Program-management tests                                |
| Program editors                                     | Existing four types and detailed choices; authored Sequence handles, compact counted selectors, stacked arrows, centered trash | Sequence captures and geometry/keyboard checks; existing ordering/selection tests                   |
| Channels and channel schedules                      | Source-owned fieldsets, preferences, preview and schedule dependencies; persistent resource actions                            | Channel editor captures with scrolled body; schedule route captures and existing editor tests       |
| Templates and Filler                                | Current catalogs and feature editors; shared corners, restrained finishes, action hierarchy and field styling                  | All catalog route captures; existing template, boundary and Filler regression tests                 |
| Playback profiles and guide/credit templates        | Source-owned catalogs/editors, existing previews; shared type, controls, fields and surfaces                                   | Catalog route captures and existing profile/template checks                                         |
| Guide                                               | Original timeline/artwork; compact M3U/XMLTV copy controls and existing clipboard feedback                                     | Feed clipboard and stable-height checks; existing guide layout/artwork/refresh tests                |
| Settings                                            | Plain heading icons, tab-owned drafts and footers; Engine details popup without status-card reflow                             | Popup light-dismiss/Escape/focus and geometry checks; existing tab/draft tests                      |
| Quick Setup                                         | Existing wizard and conditional steps; shared controls and prominent action icons                                              | Desktop/mobile route captures and existing Quick Setup tests                                        |
| Shared actions, help, menus and dialogs             | Stable armed footprint; existing confirmations, guards, contextual help and native semantics                                   | Sequence/overlay assertions, feedback checks and existing interaction-safety tests                  |

The suite covers 1440×1000, 390×844 and 320px layouts, plus catalog breakpoint boundaries. Existing documentation scenarios cover detailed editors and working states. Real asynchronous behavior, query results, playback readiness, and persisted drafts remain owned by the application; the reference gallery's simplified demonstrations do not replace them.

## Verification commands

```bash
npm run build
npx playwright test --config tests/e2e/design-language/application.config.ts
npm run typecheck
npm run lint
npm run format:check
npm run docs:user:screenshots:update
npm run docs:user:check
npm run docs:user:review:list
```

Screenshot regeneration and authored guide updates do not approve user-guide digests. Preserve the review queue for the user. Compare real application captures using matching fixture data and viewports; different timestamps, names, data counts, and rasterization are not evidence of structural divergence on their own.

## Final consistency review · 2026-10-19

The final audit reviewed production owners, shared styles, guide specifications, standalone behavior, and the isolated application. It corrected these remaining gaps:

- The guide's AI dependency check still targeted the removed Advanced row. It now activates the provider-header handle, matching the integrated title/switch/disclosure composition.
- Token validation now recognizes custom properties declared locally in the stylesheet under test, including the catalog control-height variable; undefined references still fail.
- Generic checkbox and switch specimens now match the source-owned 16px checkbox and 36×20px switch with a 14px thumb. Compact Library checkbox rows and independent immediate AI activation are documented explicitly.
- Phone/coarse-pointer text fields and Settings switch hit rows now meet the guide's 44px minimum. Specialized checkbox, radio, range, color, file and hidden inputs retain their own presentation.
- Native production select styling is distinguished from the gallery wrapper implementation. The same caret presentation does not require importing gallery markup or styles.
- The completed radius trial is now permanent: production and reference tokens own the 2/4/6/8px scale directly, and the comparison images remain historical evidence.
- Library saves use the shared editor confirmation above its persistent actions. The duplicate page toast was removed because it could cover Reset and pause dismissal while hovered.
- Draft regression checks retain the Guide Template editor's type tab and Library settings permalink instead of asserting unrelated Settings routes.

Earlier per-pass test totals and capture counts have been superseded by this final review:

| Check                                                                                         | Result                                                                                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Web unit tests                                                                                | 401 tests across 81 files passed                                                                                     |
| Production design and feedback browser checks                                                 | All 9 passed together against the final build                                                                        |
| Existing Settings, draft protection, backup, disclosure, compact-editor and Guide regressions | 61 distinct cases passed across focused runs after correcting stale URL expectations and the duplicate Library toast |
| Standalone guide behavior, links, tokens, font and contrast                                   | All 27 checks passed                                                                                                 |
| Authored documentation screenshots                                                            | All 23 workflows passed; all 78 staged images were newer than the final application build before publication         |
| Static and build checks                                                                       | ESLint, type checking, production builds, focused style/specification formatting and whitespace checks passed        |

The final audit regenerated and visually inspected 89 reference images (including two historical radius comparisons) and their hashes; the local help snapshot now contains 30 topics and 97 assets.

An intermediate application run encountered an asset 404 while the web output was being rebuilt; the complete final run used a finished build and passed. Repository-wide formatting still reports existing differences in unrelated files, manually maintained documentation, and generated capture metadata; those are outside the focused formatting pass. Builds emit the existing large-chunk advisory. No user application database, external AI service, deployment, or review approval is part of this audit.

The final strict repeat capture matched 72 images before stopping at `layouts/editor.png`: 23 pixels differed by at most one channel level, within a two-pixel-wide strip, with identical 1440×1000 dimensions. The remaining 16 captures were not reached by that comparison. These counts describe the final audit before radius adoption; current capture runs retain the 87 active reference images and leave the two historical comparison images untouched. This is a small rasterization difference, not confirmed byte reproducibility of the full edition. Reference images remain untouched by comparison; its diagnostic is under ignored `test-results/design-language/editor.png`.

All 27 user-guide pages validate; 23 remain in the user's review queue after the text and screenshot updates. Browser evidence uses Chromium with desktop, mobile and emulated touch contexts. Physical devices, other browser engines, screen-reader output and complete accessibility conformance remain outside this verification; see the [reference boundaries](validation.md#prototype-boundaries).

## Filler and Playback navigation

The user-requested consolidation replaces the two expandable sidebar groups with single Filler and
Playback links. `ManagementPageHeader` supplies shared section titles and route-backed collection
tabs in all four owning views. Existing collection/editor paths, defaults, contextual help and draft
guards remain intact. See [navigation](../components/navigation.md#filler-and-playback-collection-tabs)
for semantics and measurements; `tests/e2e/documentation/management-navigation.ts` covers the new composition.

The isolated navigation/capture cases cover all seven collection destinations, reload/history,
active state, retained editor drafts, contextual-help labels, keyboard activation, mobile drawer
selection and 1440/390/320px overflow/target checks. Their screenshots use the same disposable
fixtures as the user-guide workflow. Review approvals remain owned by the user.

Collection navigation restores focus to the activated link after the owning view remounts, preserving
keyboard traversal without changing native modified-click behavior. Engine details dismisses when
the page or a nested container scrolls, or the viewport resizes or rotates; reopening measures the new viewport instead of retaining stale
coordinates. Focused collection and Settings browser checks cover these regressions.

Sidebar selection uses the guide's mint text/icons, selected surface finish and 2px leading accent
edge for main destinations and nested resource links. Hover retains that selected treatment, and
compensated padding preserves the existing icon/label alignment. The production navigation browser
check exercises main and nested destinations at 1440px, 390px and 320px.
