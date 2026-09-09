# Repository Guidelines

## Working Practices

- Keep changes focused on the requested behavior. Preserve unrelated behavior, public interfaces, configuration, and manually maintained documentation unless the task requires changing them.
- Use the simplest implementation that fully satisfies the requested behavior and established
  repository constraints. Do not add speculative lifecycle management, configurability, abstraction,
  or failure handling unless the request or a concrete existing requirement calls for it. When added
  complexity is necessary, keep it bounded and make the requirement it serves clear.
- Scale concurrency and failure handling to the frequency and impact of the operation. For rare
  administrative changes, prefer safe commit-forward recovery through existing reconciliation over
  cross-component rollback or lifecycle barriers unless an explicit contract requires an atomic
  handoff or uninterrupted service. Still stop consumers before destructive cleanup can invalidate
  resources they use.
- Follow the repository's existing conventions where they are established. Prefer shared public constants and documented contracts over duplicated values or assumptions.
- Before designing substantial new functionality, identify plausible maintained libraries that could
  provide the required behavior and surface strong candidates early. Compare their feature and
  security fit, maintenance status, integration and operational costs, and the custom work that would
  remain; recommend adoption when it is a better fit, but do not add a dependency solely to avoid a
  focused implementation that better matches the repository's constraints.
- Always use braces around control-flow bodies, including single-statement `if`, `else`, loop, and similar blocks.
- Put `else` on a new line after the preceding closing brace; do not use `} else {`.
- Use tab indentation for JavaScript, TypeScript, Vue, and CSS source. Follow a StandardJS-inspired style with Stroustrup braces while retaining and enforcing semicolons.
- Keep an object property name and the beginning of its value on the same line when the expression remains readable. Do not strand a property name above a short conditional, nullish-coalescing expression, or other compact value.
- Use one empty line between discrete logical chunks within functions, methods, and callbacks. Separate phases such as validation, normalization, resource setup, data retrieval, derivation, persistence, cleanup, and result construction when they are conceptually distinct.
- In long functions, add short inline comments that identify each discrete phase or state transition, such as loading prior state, flagging missing records, persisting results, or performing cleanup. Explain the purpose of the chunk without narrating individual statements or over-commenting short, self-explanatory code.
- Keep closely related declarations and operations together. Do not mechanically add an empty line after every control-flow block or before every return, and do not separate `if` from `else` or `try` from `catch` or `finally`.
- Maintain backward compatibility unless a breaking change is explicitly requested. Make migrations and persistent-data changes safe, bounded, and reversible when practical.

## Code Organization

- Prefer single-purpose files and components with a clear owner for each responsibility. Very short, tightly related functionality may remain together when splitting it would obscure rather than clarify the design.
- Keep HTTP route registration, repository persistence/query domains, page coordination, and substantial editor sections in focused modules. Treat top-level application, repository, and page files as composition boundaries rather than indefinite containers for new behavior.
- Put server implementation modules in their owning domain directory under `apps/server/src`, such as
  `artwork`, `guide`, `media`, `operations`, `playback`, `repository`, `routes`, `scanner`, or
  `scheduling`. Reserve the server source root for application composition, bootstrap, configuration,
  documentation generation, and genuinely cross-cutting primitives. Import concrete owning modules
  directly instead of adding catch-all directories or barrel files, except for an established public
  facade such as `repository/index.ts`.
- When a file becomes difficult to review or mixes unrelated responsibilities, extract cohesive modules before adding another major feature. Preserve existing public interfaces during structural refactors when practical.
- Keep production JavaScript, TypeScript, and Vue files within the configured ESLint line budgets. Treat the limit as a backstop, not a target; extract a responsibility before a file approaches it.
- Keep web styles in feature-oriented Sass partials under `apps/web/src/styles`. Put shared primitives in the foundation partial, feature rules in their owning partial, and cross-feature breakpoints in the responsive partial; do not recreate a monolithic global stylesheet.

## User Interface

- Presentations and controls for similar content should follow similar patterns. Typical exceptions
  are adaptations for compactness or a more generic context.
- Every asynchronously loaded collection must have an explicit initial loading state. Do not render an empty state, zero count, or other absence claim until the first load has completed successfully. Keep loading, loaded-empty, populated, and failed states distinguishable.
- Present transient action confirmations, such as saved, copied, queued, or started messages, as
  auto-dismissing toasts with manual dismissal and enough time to read or interact. Keep failures,
  warnings, and states that require user attention persistent and in context instead of dismissing
  them automatically.
- Confirm deletion of persisted top-level resources and other significant permanent data in a styled
  modal. For nested, draft-local removals that can be undone by cancelling or discarding the editor,
  use a compact two-step action instead: the first activation must visibly arm the control and change
  its accessible label, while the second performs the removal. Allow the armed state to be cancelled
  with Escape, an outside interaction, another armed action, or a short timeout.
- Give transient resource editors a consistent header with an accessible close icon at the upper
  right. Route the close icon, backdrop dismissal, and Escape through the same unsaved-changes flow
  whenever the editor owns a saveable draft.
- Keep saveable resource-editor actions in a persistent bottom bar outside the scrolling content.
  Place `Delete <Type>` at the left for existing standalone resources and group `Reset` then `Save`
  at the right. Enable Save only for a valid pending draft, enable Reset only when the draft differs
  from its captured baseline, and keep both disabled during conflicting work. Require a compact
  two-step confirmation before Reset discards the draft; keep permanent Delete behind a styled modal
  confirmation and available even when unsaved edits will be discarded.
- Use subtle, context-appropriate motion when it clarifies presentation, dismissal, expansion,
  collapse, spatial relationships, or asynchronous state changes. Do not add animation solely for
  decoration or animate frequently changing data when doing so would add noise or imply false
  stability.
- Keep UI motion brief and restrained, preserve focus and interaction behavior throughout animated
  transitions, and provide an effectively immediate reduced-motion experience without meaningful
  translation or scaling.
- Model custom motion timing and easing on established platform conventions instead of choosing
  arbitrary durations. For deliberate presentation transitions, prefer Apple-style system timing
  as the touch-oriented baseline: approximately 350 ms with an ease-in-out curve. Use shorter
  durations for frequent or lightweight feedback where the longer transition would impede use.
- When presenting or dismissing a control changes the space occupied by surrounding content,
  animate the affected layout in the same direction, duration, and easing as the control. Keep the
  spatial relationship clear while containing layout work and avoiding animation-driven rendering
  churn that causes stutter.
- Treat smoothness and rendering performance as requirements for every animation. Prefer
  compositor-friendly opacity and transform changes, keep animated layout work tightly contained,
  and avoid per-frame measurements, reactive updates, or expensive rendering. Verify experiential
  motion in a representative browser and device viewport when practical; simplify or remove an
  animation that cannot remain consistently smooth.
- When surrounding content must visibly move because a control changes occupied space, prefer a
  FLIP-style transition: commit the final layout once, measure the displacement once, apply an
  inverse visual offset before paint, and animate that offset to its final position using a
  compositor transform. Reconcile sticky offsets, virtualized-list geometry, and other dependent
  measurements once after completion instead of on every frame.
- Animate presentation layers that accompany a FLIP transition, such as a newly exposed header or
  panel background, as independent opacity or transform layers using the same duration, direction,
  and easing. Avoid animating height, grid tracks, margins, or other layout properties when doing so
  would continuously reflow substantial, sticky, or virtualized content.

## Testing

- Prefer tests that exercise observable behavior over tests that inspect implementation source. A test’s name and stated coverage must match what its assertions actually prove. Do not use source-text or regular-expression assertions as the primary regression test for runtime behavior merely because nearby tests use that style. Source-text assertions may supplement behavioral coverage or verify genuinely static contracts.

- For migration or upgrade behavior, execute the real migration or installation path from representative prior state and assert the resulting persisted settings, capabilities, and preserved values. Include the relevant prior schema/version markers and configuration in the fixture. If the current harness cannot exercise the behavior, extend it when practical; otherwise state the coverage gap instead of presenting a source-text assertion as a behavioral regression test.

- When changing behavior, add or update focused tests when practical and worthwhile. Tests solely for string changes or simple layout changes are usually not useful, and tests should avoid fragile dependence on fixed text when reasonable.
- Keep tests resilient to intentional configuration changes. Derive fixtures, boundary assertions, and generated-value expectations from the same public constants or documented contract values used by the behavior under test.
- Avoid exact-string assertions for incidental implementation details. Use exact matches when the string itself is a stable API, wire-format, security, or compatibility contract.
- Keep automated tests under the root `tests/` directory, mirroring the source tree they exercise. Keep browser tests under `tests/e2e`; do not add sidecar test files alongside production source.
- Run the most relevant available checks for the changed behavior. Report checks that could not be run and any remaining verification gaps.

## Database and Resource Use

- When implementing code that may touch the database, avoid changes that permanently increase the number of queries run per request. Run queries only when they are necessary to retrieve or modify data for that request.
- When extra queries are unavoidable, minimize them and keep their cost scoped to the workflows that need them. Avoid introducing repeated or per-item queries when the data can reasonably be fetched together.
- Consider performance and documented resource limits in affected workflows, without adding complexity for speculative optimization.

## Documentation

- Use concise JSDoc (`/** ... */`) for every named function or method, class, interface, type alias, public schema, and meaningful module-level constant. This includes file-local helpers and private methods, but excludes anonymous callbacks, local variables, routine Vue refs/reactive form state, tests, generated files, and vendored code.
- Give class JSDoc enough context to explain the class's purpose, the state or resources it owns, and
  important lifecycle behavior, side effects, or boundaries. Two or three concise sentences are
  usually sufficient. One sentence is acceptable for an error class when it fully describes the
  represented failure.
- Describe every HTTP operation with its shared Zod request and response contracts, stable operation ID,
  tags, and concise summary so the generated OpenAPI document remains complete. Update the AsyncAPI
  contract when WebSocket event types or delivery behavior change, and run `npm run docs:api:check`
  after changing either interface.
- Wrap documentation comment prose at the repository's configured page width rather than leaving long prose on a single line.
- Prefer simple, clear language except where precise technical terminology is needed. Explain purpose, observable behavior, invariants, side effects, ownership, resource limits, and failure conditions rather than merely restating the declaration name.
- Describe meaningful transformations and decisions instead of vague mechanics such as "map X to Y," "update the interface," or "add to the workflow." Name important normalization, derived values, fallbacks, state changes, and side effects when they explain why the code exists.
- Let TypeScript express parameter and return types. Use JSDoc tags such as `@param`, `@returns`, `@throws`, `@example`, and `@deprecated` only when they add information that is not already clear from the signature.
- Update nearby JSDoc whenever a documented contract or behavior changes. Preserve accurate existing comments and clarify them instead of replacing them mechanically.
- Keep the JSDoc lint checks enabled for production code. Do not satisfy them with generated descriptions that merely restate declaration names.
- Keep `docs/technical-outline.md` updated as the precise, high-level map of the project's distinct
  functionality groups. Keep the root `README.md` concise and link to the technical outline instead of
  duplicating it there.
- The technical outline and README may contain manually maintained sections. Preserve their wording
  unless the user explicitly asks to change it. When code adds, removes, or materially changes
  behavior, update only the relevant technical section. Include security, compatibility, migration,
  and resource-limit behavior where those measures belong.
- Treat `apps/docs` as the user-facing guide for released behavior. User-visible changes must update
  the affected guide topics and any screenshots that no longer match the application. Keep prose
  task-oriented and understandable without developer terminology when a plain-language explanation
  is available.
- Do not hard-wrap user-guide Markdown prose. Keep each paragraph on one source line and let the editor soft-wrap it; preserve structural line breaks in lists, tables, frontmatter, and code blocks.
- Never approve a user-guide digest on the user's behalf. Authored or regenerated content must remain
  unreviewed until the user explicitly instructs an approval. Use `npm run docs:user:review:list` to
  surface the queue and `npm run docs:user:check` to validate page structure, links, topic mappings,
  screenshots, and review state.
- Before preparing a release, follow the checklist in `CONTRIBUTING.md`: regenerate documentation screenshots before reviewing and approving their pages. The production review gate checks stored digests, not whether screenshots match the current UI; do not treat a passing gate as evidence of screenshot freshness.

## Security and Compatibility

- Validate input at trust boundaries and preserve established security controls. Do not expose credentials, tokens, personal data, or other sensitive values in source, logs, fixtures, or error messages.
- Normalize untrusted user/provider values at the boundary according to their semantics. Canonicalize and deduplicate set-like values, preserve order for authored sequences, and reject duplicate stable identifiers that would share state or ownership.
- Preserve user-facing spelling separately from canonical comparison keys. Enforce case-insensitive uniqueness with explicit validation and database constraints; do not rely on raw SQLite constraint messages for normal conflict handling.
- Treat stable APIs, wire formats, stored data, and documented configuration as compatibility contracts. Call out intentional contract changes and cover them with appropriate tests and migration or upgrade guidance.
