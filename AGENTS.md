# Repository Guidelines

## Working Practices

- Keep changes focused on the requested behavior. Preserve unrelated behavior, public interfaces, configuration, and manually maintained documentation unless the task requires changing them.
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

- Every asynchronously loaded collection must have an explicit initial loading state. Do not render an empty state, zero count, or other absence claim until the first load has completed successfully. Keep loading, loaded-empty, populated, and failed states distinguishable.
- Present transient action confirmations, such as saved, copied, queued, or started messages, as
  auto-dismissing toasts with manual dismissal and enough time to read or interact. Keep failures,
  warnings, and states that require user attention persistent and in context instead of dismissing
  them automatically.

## Testing

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

## Security and Compatibility

- Validate input at trust boundaries and preserve established security controls. Do not expose credentials, tokens, personal data, or other sensitive values in source, logs, fixtures, or error messages.
- Normalize untrusted user/provider values at the boundary according to their semantics. Canonicalize and deduplicate set-like values, preserve order for authored sequences, and reject duplicate stable identifiers that would share state or ownership.
- Preserve user-facing spelling separately from canonical comparison keys. Enforce case-insensitive uniqueness with explicit validation and database constraints; do not rely on raw SQLite constraint messages for normal conflict handling.
- Treat stable APIs, wire formats, stored data, and documented configuration as compatibility contracts. Call out intentional contract changes and cover them with appropriate tests and migration or upgrade guidance.
