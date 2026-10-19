# Shared behavior contract

[Handbook](../README.md) · [Tokens](tokens.md) · [Layouts](layouts.md)

These rules apply to every family unless a documented variant overrides them. A specimen can show a
state without implementing the application operation; consult the prototype boundary below.

## States and semantics

| State         | Visual contract                                                              | Behavioral contract                                                                                                 |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Default       | Semantic surface, text and boundary                                          | Native semantic element wherever practical                                                                          |
| Hover         | Hover surface or accent-hover fill                                           | Never the only route to information or action                                                                       |
| Pressed       | Selected surface or accent-pressed fill                                      | Temporary feedback for activation, not persistent selection                                                         |
| Focus visible | 2px accent ring, 3px offset                                                  | Keyboard-visible and unobscured; do not remove native focus without replacement                                     |
| Selected      | Selected fill plus edge, check or active label                               | `aria-pressed`, checked state or explicit selection semantics appropriate to the component                          |
| Disabled      | 0.48 opacity, retained meaning                                               | Native disabled; explain unmet prerequisites in visible help when non-obvious                                       |
| Busy          | Stable geometry, action-specific progress text                               | Announce busy state, prevent conflicting work and retain draft values                                               |
| Invalid       | Danger boundary and repair message                                           | Associate the message, expose invalid state, preserve input                                                         |
| Armed         | Caution/danger surface, checkmark, optional text and changed accessible name | First activation does not discard; cancel with blur, Escape, outside interaction, another armed action or 5 seconds |

Ordinary text, badges and structural panels have no hover, pressed, busy or disabled state unless they
actually become interactive. Do not apply disabled opacity to an entire panel containing useful help.

Use an explicit accessible name for every icon-only action. Decorative icons have empty alternative
text or are hidden from accessibility APIs. Use a real heading hierarchy and labeled regions. A
control's label must describe its action, not its visual icon. Native buttons support Enter and Space;
links support navigation; do not make generic divs act like controls.

## Asynchronous work and feedback

First load must visibly say loading. After a successful result, render empty or populated. A failed
initial load has a persistent in-context error and recovery action; it is never an empty result.
Refresh may retain prior data, but mark refreshing and preserve the failure context if it fails.
Unknown values are unavailable or checking, never zero or ready.

Success confirmations are toasts: five seconds, manual dismissal, paused while hovered or focused.
They do not move focus. Use a polite status announcement. Failures, warnings, unresolved conflicts and
other required actions stay visible in context. Avoid flooding live regions during typing, scans,
progress or log streaming. Prefer a settled result announcement and meaningful phase changes.

## Drafts, confirmations and focus

A resource editor captures a baseline, tracks pending changes and validates its draft. Reset uses an inline checkmark-style two-step action and requires
a changed draft and two-step confirmation. Resource editors show Close when pristine and Save for a valid changed draft. Settings tabs retain their own Save-based footer. Both are disabled
during conflicting work. Delete remains available for an existing standalone resource, including with
unsaved or invalid edits, and requires a styled resource-specific modal.

All editor dismissal routes use the same guard. Clean drafts close; dirty drafts open a safe-default
discard confirmation. Cancelling preserves the draft and returns focus to its prior control. On
presentation, focus enters the dialog. Modal content contains focus and makes the background inert.
On dismissal, return focus to the opener, or a logical next resource if the opener was removed.
A confirmation stacked over an editor closes before its parent and preserves the parent's focus.

For nested draft-local removals, arm the action visibly before removal. A reset or removal arm cancels on blur. Its accessible pressed state follows arming. A reset or removal arm cannot
remain active while another action is armed. Pressing Escape first cancels an armed action; another
Escape can dismiss the enclosing editor through its guard. A save failure preserves values and shows
an actionable error; a successful save updates the captured baseline.

## Layout, density and breakpoints

| Available viewport | Reference layout                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Above 1220px       | 244px navigation rail, 28px vertical / clamp(24px, 2.6vw, 42px) horizontal page inset, optional 390px inspector, 24px workspace gutter |
| 901–1220px         | Persistent rail, inspector presented in the existing modal drawer, 28px vertical / clamp(24px, 2.6vw, 42px) horizontal page inset      |
| 601–900px          | Drawer navigation, 24px page inset; toolbar wraps                                                                                      |
| 600px and below    | 16px page inset; one-column forms, 44px controls and targets, compact source-owned lists and media grids                               |

The gallery reference points are 1440×1000 and 390×844 at device scale 1. Verify at 320px width and
200% text scaling as well. Components grow with wrapped text. Never shrink type to fit a fixed box.
The app content maximum is 1600px; forms should not become unbounded lines of text. Single text fields
prefer a 560px maximum outside deliberate two-column arrangements. Use rem for typography and CSS
pixels for the geometric rhythm. Respect larger root sizes and safe-area insets.

Collections and timelines contain their own horizontal overflow. Preserve keyboard scrolling and
provide an alternative mobile presentation when comparison is no longer useful. An inspector hidden
for space needs an explicit details route in production. A screenshot's cropped viewport is not a
license to make controls unreachable: scrolled captures show the remaining content.

## Motion and rendering

| Motion                   | Token                     | Use                                                            |
| ------------------------ | ------------------------- | -------------------------------------------------------------- |
| Lightweight feedback     | 110ms, feedback easing    | Button fill, switch thumb; no layout changes                   |
| Small state presentation | 170ms, feedback easing    | Quiet opacity change when useful                               |
| Deliberate presentation  | 350ms, system ease-in-out | Dialog/drawer presentation or spatial transition               |
| Reduced motion           | Effectively immediate     | No meaningful translation or scaling; focus behavior unchanged |

Do not animate constantly changing metrics or use motion just to decorate. If revealing a control
moves substantial surrounding content, commit final layout once, measure displacement once and
animate the inverse transform with the same timing as the presentation layer. Reconcile sticky and
virtualized geometry after completion, not every frame. Direct layout animation is acceptable only
when representative browser/device checks establish acceptable performance. This reference needs no
moving large-layout transition; its dialog uses a small opacity/translation entrance only.

## Prototype boundary

Working examples: native draft fields and disclosures; language-combobox lookup using a small local
fixture; subtitle/encoding dependencies; segmented and detailed choices; coordinated two-step actions;
source-shaped Program selection and desktop/modal inspection; separate mobile navigation; contextual
help with actual bundled topic HTML and persistent failed/loading variants; protected channel and
Sequence drafts; valid-pending Save and baseline-aware Reset; dirty dismissal and permanent-delete
confirmations; local media selection, Select/Clear Page and destination choice; library menus and
scan-history presentation; log filtering/details; dismissible five-second success toast.

Illustrative only: backend search/filter/sort execution, multi-page data fetching, media probing,
subtitle track evaluation, full language catalogs, image cropping/encoding, external IPTV feeds,
AI/provider operations, backup archive operations, scheduling algorithms, live playback and log
streaming, conflict handling and network recovery. The filter dialog exposes current fields and
native draft values without executing a database query. Timeline content is a fixed illustrative
window; Sequence preview is a single track, separate from Guide channel listings. No simulated
operation is evidence of a backend result. Inert operation examples and source-only variants are
listed in [the audit](audit.md); they are not new product workflows.

The prototype uses native modal and popover containment instead of introducing a new component
framework. Production adoption should use Moirai's established Vue components, draft protection and
focus tooling; importing this gallery is not an application integration plan.
