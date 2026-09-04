# Scheduling architecture

Moirai treats the concrete playback timeline as generated output. The editable model is a set of reusable programs, daily templates, and a layered channel schedule:

```text
Channel schedule -> ordered conditional template layers -> slots -> programs -> indexed media
                 \-> always-available base template -> slots -> programs
                                                    \-> explicit boundaries
```

A content program combines an eligible source (`item`, explicit `collection`, `group`, explicit `group-collection`, or `library-query`) with an independent selection strategy (`sequential`, deterministic `shuffle`, or deterministic `random`). Explicit collections retain up to the configured item capacity, which defaults to 5,000 and has a 25,000-item contract ceiling. Group collections retain up to 1,000 unique media groups from one library, including shows, seasons, artists, and albums. They include descendant media and deduplicate overlaps; sequential selection orders shows by season and episode metadata and music videos by artist, album, disc, and track metadata. A sequence program composes counted references to other programs and may repeat. This avoids source-specific slot types and retains the authored sequence instead of flattening it into configuration-time timeline entries.

Templates represent one local calendar day. Calendar selection is stored above templates as an ordered channel stack. The first matching conditional layer that supplies a program wins; an always-available base template is the final fallback. Conditions support nested all/any groups with negatable month, weekday, exact-date, date-range, recurring annual-range, and local-time leaves. Overnight time ranges are anchored to the local date on which they begin. The contracts bound layer count, predicate size, and nesting depth so authored conditions remain safe to validate and resolve.

A slot whose program is explicitly `null` means “no program at this layer.” It falls through to the next matching lower layer, or to the base template. Source outages, empty programs, and missing media do not fall through: the selected rule remains authoritative and produces its own filler or dead air. This distinction prevents a temporary source failure from unexpectedly replacing intended programming with unrelated lower-priority content. A no-program slot in the base template uses channel filler when configured and otherwise materializes dead air.

## Configuration, state, and output

Authored configuration and runtime selection state have separate tables. Each state record is addressed by a stable consumer key and has a fingerprint of only the source/strategy configuration that affects it. Resizing a slot or changing a boundary therefore does not reset an unrelated cursor. Persistent slots retain their cursor between occurrences; occurrence-scoped slots get a date-specific cursor. Sequence entries and filler have independent state keys.

Sequential state retains the last item and fallback position. Shuffle state persists its cycle, membership, remaining order, and last item. Newly eligible media is inserted deterministically without reordering the remaining pool, and removed media is discarded. Random selection is derived from a stable seed and counter. A preview clones stored state and returns `proposedState`; it never writes a checkpoint. The rolling materializer is the sole production writer: it stores segment state transitions and atomically replaces the concrete future range and exact tail cursor checkpoint.

Generated segments have concrete instants, source offsets, physical playback parts, and a role of `primary`, `filler`, or `dead-air`. Missing/deleted items, invalid multipart sequences, and media without a positive duration are skipped with structured issues. Issues retain a bounded list of exact occurrences, their boundary origin, and a total occurrence count. Rolling materialization merges retained and regenerated occurrences around the replacement point. A valid multipart item occupies one logical segment while its physical files play sequentially. The durable committed window is adapted into validated, non-overlapping daily ErsatzTV playout JSON; preview generation remains noncommitting. During that final adaptation only, every uncovered interval uses a channel override, global override, or immutable bundled playback fallback. The selected video starts from zero for each observed continuous gap and is truncated or looped to fit exactly. Regeneration derives its source offset from the materialized dead-air interval start, or from a fixed epoch when the guide has no segments, preserving playback position without reading prior playout documents. Silent fallback video receives synthetic audio. Materialized dead air remains unchanged so guide warnings continue to describe schedule quality rather than output safety.
Managed playback fallback uploads must contain exactly one video stream, and that stream must have a
measured duration of at least one minute; authored schedule filler retains its normal duration and
may be shorter.

Missing-duration diagnostics do not reject otherwise valid committed programming. A changed catalog
can immediately replace an entirely dead-air future caused by unavailable or unprobed media when
the authored schedule resources remain unchanged. Recovery preserves elapsed dead air and does not
repeatedly regenerate an unchanged catalog. Live previews and committed generation use separate
worker catalog identities because their availability policies differ.

Library reachability and per-item observation are persisted separately from the authored rules. A degraded scan keeps positively observed items eligible while retained missing items become unconfirmed; a source-root outage makes the library unavailable without deleting its index. Unavailable content is not selected and does not advance primary, composite, shuffle, or filler state. Exact references that are truly deleted remain in program configuration as repairable broken references. Explicit item and group collections continue with their surviving playable members and report missing members as degraded; if none remain, they resolve to inherited filler or dead air until repaired.

## Boundary decisions

Boundary policy belongs to an explicit object between adjacent slots. This makes the nominal target and the relationship it resolves unambiguous, including the final boundary from the last slot back to the first slot on the next day. Slot resizing changes nominal starts and boundary targets; it does not alter resolution policy. Conditional layers additionally own separate entry and exit boundary configurations because entering a higher-priority layer and returning to lower-priority programming are distinct transitions.

The initial propagation rule keeps the next nominal anchor fixed. An overrun or early handoff changes
only the immediately adjacent slot's resolved start and therefore shortens or expands that slot. Its
outgoing boundary still targets the following nominal time. If an allowed overrun displaces an entire
adjacent slot, the engine skips that slot with a diagnostic to keep the timeline monotonic; product
behavior for such extreme overlaps can be revisited before it is finalized.

The supported policies are:

- `hard`: retain the nominal boundary. The slot's start-eligibility rule decides whether a crossing item is rejected or truncated.
- `finish-left`: allow an eligible crossing primary item to finish when the result is within maximum drift. Drift may instead be explicitly unlimited, in which case that one item always finishes and later slots resume at its actual finish time. A finite boundary may separately fall back to starting incoming content early, within its own early-start limit, after no outgoing item satisfies the late limit. Other fallbacks truncate or reject the item.
- `favor-right`: when primary content ends close enough before the target, start the right slot at that item boundary. The following nominal anchor remains fixed.

Start eligibility is independent of boundary ownership: require a full fit, permit truncation, permit an overrun for boundary resolution, or permit an overrun only within a slot-specific tolerance. Candidate state is advanced only after a candidate is accepted, so a rejected too-long item is not silently consumed.

Unlimited drift is stored as a nullable drift limit rather than a sentinel duration. It is valid only for `finish-left`. A sufficiently long outgoing item may cross midnight or displace several nominal slots or an entire conditional window; nominal anchors remain authored in place, and materialization skips displaced intervals until the item finishes.

The early-start fallback is stored independently from the primary late-drift limit and defaults to
zero for existing schedules. It is available only on finite `finish-left` boundaries. Candidate state
is committed only for accepted outgoing content, so handing off early or retaining dead air does not
consume a rejected sequential or shuffle choice.

## Filler decision

Filler is inherited from slot override/disable, then template default, then channel default. It uses normal programs and isolated selection state, always starts a selected item at source offset zero, and never delays primary content. It does not initially resume partially played filler.

The default `best-fit-or-truncate` policy chooses the longest eligible item that fits the remaining gap, using strategy order as the stable tie-breaker. If nothing fits, it selects normally and truncates at the boundary. Other stored policies allow normal selection with truncation, normal selection only when it fits, or best-fit only. These explicit policies leave room for later resume- or gap-aware strategies without changing primary scheduling.

## Time and determinism

The single configured `MOIRAI_TIME_ZONE` defines local template geometry. Temporal's compatible disambiguation is used: repeated local times select the earlier occurrence and nonexistent local times shift forward. Timeline timestamps are instants, so 23- and 25-hour local days and media crossing midnight remain representable.

Preview requests are limited to 14 days and 5,000 materialized segments; finer-grained requests are rejected before they can monopolize the server event loop or produce an unbounded response. Media, group ancestry, genres, programs, and state are loaded in bounded bulk queries for a request rather than queried once per selected item. Identical configuration, catalog, state, time zone, and date range produce the same segments. The committed guide retains overlapping rows during normal rolls and appends only the uncovered tail. Configuration changes become effective at the next local midnight by default, or after the current item through an explicit channel action. Segment metadata snapshots preserve already-committed guide entries after catalog deletion.

## Editing and incremental follow-up

The SPA exposes reusable Programs and daily Templates, a draggable nominal 24-hour slot editor, progressive boundary/filler controls, a dedicated channel schedule stack and predicate editor with channel schedule filler, coalesced draft previews, and a read-only weekly channel guide. Settings and channel editors separately manage uploaded playback fallback video, which is used only after schedule resolution leaves dead air. Dead-air segments use a static warning treatment plus exact-position markers so short gaps remain discoverable without changing timeline geometry. The editor classifies intentional and correctable gaps, reports exact local times and durations, and guides the user to the relevant boundary, template, program, or schedule filler configuration without mutating the current draft. Guide warnings carry stable route state for the occurrence date and affected conditional boundary. Template pages show read-only links to every channel that uses the template as a base or conditional layer. These previews deliberately leave cursor state unchanged.

The next scheduling steps include rotation rules and playback configuration that can select from the
indexed embedded and sidecar subtitle inventory. The playout adapter continues to consume the
committed ledger rather than independently advancing selection state or regenerating advertised
programming.
