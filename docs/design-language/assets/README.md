# Local reference assets

- `fonts/InterVariable.woff2`: Inter normal variable, downloaded from the author's official [font distribution](https://rsms.me/inter/font-files/InterVariable.woff2). Retained unchanged, with [SIL Open Font License 1.1](fonts/OFL.txt). The capture manifest records its exact SHA-256. No remote font requests occur at render time.
- `icons/*.svg`: Lucide paths exported from the repository's installed `@lucide/vue` 1.33.0 icon nodes, with a 24px viewBox, 2px stroke, and secondary-text or accent stroke color. See [ISC license](icons/LICENSE.txt). The gallery displays them at 20px, 24px within Settings card badges, or as 18px current-color masks beside prominent action labels. No new icon family was introduced.
- `media/*-poster.png`: unchanged copies of all 17 fictitious movie posters from [the documentation screenshot fixtures](../../../tests/e2e/fixtures/user-documentation/README.md). Matching titles, years and genres in `gallery/media-fixtures.mjs` are copied from `tests/e2e/documentation/seed.ts`. The file `echo-garden-poster.png` depicts Echo Harbor, matching the docs fixture. No external artwork services or live metadata requests are required.

All media content and names in the rendered examples are fictional fixtures. Concept images and prompts are in [concepts](../concepts/README.md).

The reference shell uses the existing Moirai logo copied from `apps/web/src/assets/moirai-logo.png`. Stored application captures under `images/current-ui/` are copied from the repository's user-guide screenshots; see [current UI provenance](../docs/current-ui.md). They are not newly captured live pages.

`help/` copies the current bundled application contextual guide from `apps/docs/dist`: actual topic HTML, review metadata, standalone chapter wrappers and 95 referenced assets. Regenerate with `scripts/help.mjs` after an application documentation build. The wrapper uses local reference styles; source text/review state and embedded screenshots are not rewritten or approved. `log-example.json` contains one synthetic request with a reserved documentation-only network address.
