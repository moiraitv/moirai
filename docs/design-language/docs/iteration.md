# Iterating this reference

[Handbook](../README.md) · [Tokens](tokens.md) · [Capture metadata](../images/captures.json)

## Local commands

From the repository root, using the existing installed dependencies:

```bash
node docs/design-language/scripts/serve.mjs
# Open http://127.0.0.1:4179
node docs/design-language/scripts/tokens.mjs
node docs/design-language/scripts/capture.mjs
node --import tsx --test tests/e2e/design-language/verify.mjs
node docs/design-language/scripts/capture.mjs --check
```

The preview server binds to `0.0.0.0` on port 4179. Set `MOIRAI_DESIGN_PORT` if 4179 is occupied. Capture and verification use
an ephemeral loopback port and close it afterward. They do not build or start the app, access a
database, regenerate user-guide screenshots, or approve documentation digests. A managed sandbox
may require permission to bind a loopback port and launch Chromium.

Use the Chromium bundled with the installed Playwright version. Capture uses `--disable-gpu`, matching the repository’s documentation screenshot harness, to avoid native-dialog text compositing glitches. If required, set
`PLAYWRIGHT_CHROME_PATH` to a compatible local executable. Screenshots record the actual browser
version and font SHA-256 in `images/captures.json`; exact byte comparison assumes the same browser,
OS, font and rasterization environment. A browser upgrade can require intentional recapture after
visual review. The default viewport is desktop 1440×1000 or mobile 390×844, device scale 1, en-US,
America/Los_Angeles, dark scheme, reduced motion.

## Change a token or component

Edit `tokens.css` for shared values; generate the token table with `scripts/tokens.mjs`. Update
component CSS and the affected family specification together. Gallery CSS is split into shared
primitives, collection/domain content, and reference/layout composition. Keep responsibilities there
rather than adding everything to one stylesheet.

`gallery/manifest.mjs` owns the family and layout lists used by navigation, capture and checks.
`gallery/fixtures.mjs` owns fictional Program content; `gallery/media-fixtures.mjs` mirrors the docs screenshot movie titles and metadata, with unchanged poster copies in `assets/media/`. `gallery/specimens.mjs` composes family boards;
`gallery/current-patterns.mjs` follows Program and Schedule compositions; `gallery/library.mjs` owns the Library.
`gallery/current-ui.css` owns their source-shaped layout rules and the shared 2px title/subtitle gap.
`gallery/surfaces.css` applies the shared restrained gradient finish across specimens and layouts.
`gallery/pages.mjs` composes full layouts; `gallery/interactions.mjs` owns local demonstration behavior.
`gallery/two-step.mjs` shares inline confirmation ownership between Reset and draft-local actions.
The token table is generated; the prose, examples and image descriptions are manually maintained.

Run verification and capture after changes, then inspect every affected PNG at its native dimensions.
Check that headings wrap deliberately, type is readable, actions remain reachable, and body scrolling
does not move persistent editor actions. `--check` compares without overwriting existing PNGs.
The capture script overwrites the named current files. Preserve a copy before an experiment; the
completed radius trial retains historical baseline captures in `experiments/radius-50/`. They are no longer regenerated or included in the current capture manifest.
Do not treat successful byte generation as visual approval.

## Change motion

Update the [motion standard](motion.md) alongside any intentional timing or behavior change. Keep
shared timing tokens synchronized with their production mappings. Exercise both normal and reduced
motion in the owning application component, including focus, retained drafts, repeated toggles and
moving neighbors. Gallery capture defaults to reduced motion, so recaptured PNGs cannot verify the
transition. Record browser/device coverage and performance limits separately from appearance review.

## Revise a concept

The three `concepts/*.txt` files contain the exact built-in ImageGen prompts used for this edition.
Concept PNGs are exploratory mood and composition studies. They may contain invented navigation,
features, copy, dates or marks; none establishes a product requirement. Exact measurements, states,
colors and behavior come from the specifications, tokens and rendered gallery.

When iterating, identify the input image as an edit target or visual reference, state the precise
change, and preserve established invariants. Use the built-in image-generation tool; copy the selected
result into this folder. Save a sibling version such as `catalog-workspace-v2.png` and its prompt,
unless replacement was explicitly requested. Update the concept index deliberately after review.
Do not use raster concepts as a source of token measurements or rebuild existing Lucide icons with AI.

## Adoption and review

This is a proposed initial standard. No application components import it. Adoption later should be a
focused application change with behavioral checks and user-guide updates for the released behavior.
Keep notable current-to-target differences in the family pages; do not maintain two competing full
specifications. Record unresolved feedback as concrete component or token questions before revising.

## Source comparison audit

Build the application workspaces, then run the isolated comparison:

```bash
npm run build -w @moirai/shared
npm run build -w @moirai/ersatztv-contract
npm run build -w @moirai/server
npm run build -w @moirai/web
npx playwright test --config tests/e2e/design-language/source-audit.config.ts
```

This reuses the isolated documentation server/seed fixture and writes only comparison evidence under
`images/source-audit/` and disposable test-results. It does not invoke publish.ts, approve review
digests or use the user's database. Gallery capture remains independent of that server/database.

`node docs/design-language/scripts/help.mjs` copies the already-built bundled contextual guide
into local reference snapshots; it preserves review state and never changes source approvals.
`gallery/corrections.css` preserves the reviewed source presentation; `form-disclosure.mjs` owns the
shared Channel disclosure anatomy. `gallery/shell.mjs`, `help.mjs`, `preferences.mjs`, `program-reference.mjs` and domain modules keep
source-shaped responsibilities separate. Add source corrections and evidence to the audit matrix;
do not infer user approval from an earlier guide statement.
