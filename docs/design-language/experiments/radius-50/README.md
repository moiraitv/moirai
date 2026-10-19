# Corner-radius trial: 50% reduction

[Handbook](../../README.md) · [Trial stylesheet](../../gallery/radius-trial.css)

The gallery loads a small override stylesheet after the regular styles. Base tokens and component specifications are preserved so this remains an experiment rather than an adopted standard.

| Role                            | Before | Trial |
| ------------------------------- | ------ | ----- |
| Small / badges / inner segments | 4px    | 2px   |
| Controls / fields / artwork     | 8px    | 4px   |
| Panels / cards                  | 12px   | 6px   |
| Dialogs                         | 16px   | 8px   |

Circles and fully rounded switch tracks remain round. Zero-radius attached surfaces stay square. Nested artwork corners continue to follow their parent panel radius minus the 1px border.

## Compare

Both images now use the same current-UI composition. The capture command temporarily disables only the trial stylesheet in the browser for the before image; no source file is reverted.

- Catalog: [before](catalog-before.png) · [trial](../../images/layouts/catalog.png)
- Editor: [before](editor-before.png) · [trial](../../images/layouts/editor.png)

## Revert

Remove only the `gallery/radius-trial.css` stylesheet link from `index.html`, then run from the repository root:

```bash
node docs/design-language/scripts/capture.mjs
```

Remove the active-experiment notice from the handbook when the trial ends. The baseline token table and component measurements need no restoration. Before images remain available here for comparison.
