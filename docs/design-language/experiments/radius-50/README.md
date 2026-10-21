# Completed corner-radius trial

[Handbook](../../README.md) · [Current tokens](../../docs/tokens.md)

The 50% reduction was adopted permanently on 2026-10-19. Production and reference base tokens now own the smaller scale directly; there is no trial override to enable or remove.

| Role                            | Previous | Permanent |
| ------------------------------- | -------- | --------- |
| Small / badges / inner segments | 4px      | 2px       |
| Controls / fields / artwork     | 8px      | 4px       |
| Panels / cards                  | 12px     | 6px       |
| Dialogs                         | 16px     | 8px       |

Circles and fully rounded switch tracks remain round. Zero-radius attached surfaces stay square. Nested artwork corners continue to follow their parent panel radius minus the 1px border.

## Historical comparisons

These before images preserve the larger corners on the composition used during the trial. They remain archived here and are no longer regenerated or included in the current capture manifest. Current examples can evolve independently.

- Catalog: [historical larger corners](catalog-before.png) · [current standard](../../images/layouts/catalog.png)
- Editor: [historical larger corners](editor-before.png) · [current standard](../../images/layouts/editor.png)

Future radius changes should update the production and reference base tokens together, then regenerate the token table and current screenshots using the [iteration workflow](../../docs/iteration.md). See [production ownership](../../docs/application-adoption.md#runtime-ownership).
