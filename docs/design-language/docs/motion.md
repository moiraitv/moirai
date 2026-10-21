# Motion

[Handbook](../README.md) · [Shared behavior](behavior.md) · [Navigation and disclosures](../components/navigation.md) · [Validation](validation.md)

Motion is part of the design language. Use it to explain presentation, dismissal, expansion,
collapse, spatial relationships and meaningful asynchronous state changes. Keep the interface calm:
do not animate decoration, gradients, live metrics or streaming log rows. An animation must not imply
that unsettled data is stable or postpone an available action.

These rules apply to new and existing screens, including compact Advanced sections and secondary
help. A disclosure's visual prominence does not determine whether its expansion should animate.

## Timing and easing

Use the shared tokens in [tokens.css](../tokens.css) and the production
[_tokens.scss](../../../apps/web/src/styles/_tokens.scss). Durations are milliseconds.

| Role                    | Duration                   | Easing                                              | Use                                                                        |
| ----------------------- | -------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| Lightweight feedback    | `--motion-fast`: 110ms     | `--ease-feedback`: `cubic-bezier(0.2, 0.8, 0.2, 1)` | Button fills, hover feedback, switch thumbs                                |
| Small state change      | `--motion-standard`: 170ms | `--ease-feedback`                                   | Quiet opacity changes and disclosure indicator rotation                    |
| Deliberate presentation | `--motion-system`: 350ms   | `--ease-system`: `cubic-bezier(0.42, 0, 0.58, 1)`   | Disclosure content and surrounding movement; dialog or drawer presentation |
| Reduced motion          | Effectively immediate      | No meaningful translation or scaling                | The same resulting state, focus and interaction behavior                   |

The deliberate baseline follows Apple-style system ease-in-out timing, with shorter feedback for
frequent interactions. Production also retains the existing `--motion-panel` 220ms overlay timing
and `--motion-enter` / `--motion-exit` compatibility tokens. They are not a second default for new
disclosures. Reuse the owning component rather than introducing per-screen timings or delays.

## Disclosures and moving layout

Animate both expansion and collapse. When a control changes occupied space, surrounding content
must move in the same direction, duration and easing as the presentation. Content, background and
indicator have distinct roles: a brief indicator rotation may accompany the longer spatial change.
Keep the title, help action, enable toggle and disclosure handle independently usable where the
source component separates them.

Prefer the existing FLIP-style approach for substantial layout changes:

1. Capture affected positions, commit the final layout once, and measure displacement once.
2. Apply inverse visual offsets before paint and animate transforms to the final positions.
3. Animate accompanying content or background layers independently with synchronized opacity or
   transform changes. Avoid stretching text as part of a scaled background.
4. Release temporary styles and reconcile sticky offsets, virtualized-list geometry and other
   dependent measurements once after completion, rather than on every frame.

Keep the affected region bounded. Avoid per-frame DOM measurements, reactive updates or continuous
height, grid-track or margin animation across heavy, sticky or virtualized content. FLIP is a
default, not a mandatory technique: direct layout animation is acceptable when representative
browser/device checks or user feedback establish smoothness and responsiveness. Do not replace a
smooth existing transition solely to enforce a technique.

Production ownership is [FormDisclosure.vue](../../../apps/web/src/components/FormDisclosure.vue)
and [its layout helper](../../../apps/web/src/components/form-disclosure-motion.ts). Use its compact
`plain` presentation for secondary disclosures instead of introducing an unanimated native-details
path. Preserve controlled open state and the owning feature's lazy-loading dependencies.

## Interaction and accessibility

- Preserve drafts and selection across collapse and reopening; animation must not reset forms or
  trigger duplicate loads. Do not disable unrelated controls while a transition runs.
- Expose expanded state and panel association through native disclosure semantics or an actual
  button with `aria-expanded` and `aria-controls`. Keep collapsed content out of keyboard navigation
  and the accessibility tree, including during its exit presentation.
- If focus is inside a panel being collapsed, return it to the trigger before making it inert.
  Otherwise retain focus. Repeated toggles must settle to the latest requested state without stale
  cleanup hiding reopened content or leaving temporary transforms behind.
- Dialogs, drawers and popovers retain their existing focus containment, Escape/outside dismissal,
  return-focus and draft guards. Entry or exit motion must not bypass these rules. Floating Engine
  details must not reflow or enlarge the status card.
- Hover, pressed, busy and armed feedback preserves target geometry. In particular, a two-step
  action keeps its unarmed dimensions and position when armed; no scaling or sliding its target.
- Respect `prefers-reduced-motion: reduce` in CSS and scripted transitions. Commit the final layout
  effectively immediately, skip meaningful translation/scaling and preserve focus, announcements
  and cancellation. Essential progress still communicates state without relying on movement.

## Verification and reference boundaries

Review opening and closing in a representative browser at desktop, 390px and 320px widths. Check
long content, nested disclosures, scrolling, persistent actions and any sticky or virtualized
neighbors. Try rapid reversal, keyboard activation, collapse with focus inside, retained drafts and
reduced motion. Check that content never jumps after cleanup and that focus rings remain visible.
Inspect actual playback of the transition for stutter; a screenshot or a running-animation assertion
alone does not establish smoothness. Simplify or remove motion that cannot stay responsive.

[The disclosure browser checks](../../../tests/e2e/disclosure-motion.spec.ts) exercise AI Advanced
and nested warning-help animation, affected AI siblings, retained draft values, focus, inert closed
content, narrow layouts and immediate reduced-motion behavior. They do not establish performance on
physical devices or every disclosure owner. See [application adoption](application-adoption.md) for
broader production coverage and [validation limits](validation.md) for unverified environments.

The standalone gallery retains bounded native examples and a small dialog entrance; it does not
reproduce the production layout-transition engine. PNG captures use reduced motion for stable
reference states. They specify appearance, not transition quality or timing. Verify production
motion with normal motion enabled as well as reduced motion before considering a change complete.
