# Technical outline

> This technical outline is generated and automatically maintained by the project's coding agent
> as the implementation changes.

This document is the high-level technical map of Moirai. It describes the major subsystems, their
responsibilities, and the contracts between them. For the scheduling domain in greater depth, see
[Scheduling architecture](scheduling-architecture.md).

## System overview

Moirai is a self-hosted IPTV scheduler and streaming server. It has five main responsibilities:

1. Discover media and maintain a searchable SQLite index.
2. Turn reusable scheduling rules into a concrete, durable timeline.
3. Convert that timeline into ErsatzTV-Next playout documents.
4. Serve live HLS channels, an M3U playlist, and an XMLTV guide.
5. Provide a Vue single-page application for configuration and status.

The primary data flow is:

```text
Video files + filenames + NFO and subtitle sidecars
        ↓
Indexed catalog
        ↓
Programs → templates → channel template stack
        ↓
Committed 14-day timeline
        ↓
Daily ErsatzTV playout files
        ↓
HLS streams + M3U + XMLTV
```

Configuration, runtime state, and generated output remain separate. A materialized timeline is an
output of scheduling rules, not the editable schedule itself.

## Glossary

### Media and indexing

| Term            | Meaning                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library         | A configured collection of media with one type and one source, such as an on-disk Movies library.                                                                                   |
| Library source  | The provider and location from which a library discovers media. The initial provider is an on-disk path.                                                                            |
| Indexed catalog | The searchable database view of configured libraries, media groups, media items, metadata, and availability.                                                                        |
| Media item      | One logical video, backed by one file or an ordered multipart sequence, with indexed presentation metadata, measured playback facts, availability, artwork, and subtitle inventory. |
| Media group     | A browsable parent for related items. Shows, seasons, artists, and albums are groups; episodes and music videos are media items beneath them.                                       |
| Playback path   | The path to a media item as seen by the integrated channel worker. It may differ from the path Moirai scans.                                                                        |
| Scan            | One bounded discovery pass that compares a library source with the existing index.                                                                                                  |
| Tombstone       | A record that an indexed item was missing during a healthy scan. Repeated observations or explicit approval are required before deletion.                                           |
| Reconciliation  | The process for confirming removals or accepting a changed library source without treating a temporary outage as deletion.                                                          |

### Scheduling

| Term               | Meaning                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Channel            | A numbered linear station with presentation, normalization, guide, schedule, and playback configuration.                                         |
| Program            | A reusable rule defining eligible content and how Moirai selects it. A program is not a concrete guide entry.                                    |
| Content source     | The eligibility portion of a program, such as selected items, a show, selected seasons, a library query, or another sequence of programs.        |
| Selection strategy | The reusable ordering behavior applied to eligible content, such as sequential, deterministic shuffle without repeats, or deterministic random.  |
| Selection state    | Runtime cursor data kept separately from authored configuration. It records progress such as the next episode or remaining shuffle pool.         |
| Sequence program   | A composite program that selects counted items from other programs in an authored order, then repeats or stops.                                  |
| Template           | A reusable nominal structure for one local day. It contains slots and the boundaries between them.                                               |
| Slot               | A nominal time interval in a template. It references a program or explicitly supplies no program so a lower channel layer can show through.      |
| Boundary           | The relationship between adjacent slots that determines whether playback stops exactly, finishes the outgoing item, or favors the incoming slot. |
| Drift              | The permitted difference between a nominal boundary and its duration-aware resolved time. It may be finite or unlimited where supported.         |
| Filler             | Low-priority, interruptible content used for a remaining gap. It has separate selection state and never delays primary programming.              |
| Channel schedule   | The ordered stack that assigns one base template and optional conditional template layers to a channel.                                          |
| Base template      | The always-available lowest template in a channel schedule. It supplies programming when no higher layer applies.                                |
| Conditional layer  | A higher-priority template assignment that applies only while its predicate matches.                                                             |
| Predicate          | A nested set of date, month, weekday, annual-range, or time-range conditions controlling a conditional layer.                                    |
| Nominal schedule   | The authored slot geometry before media durations and boundary policies are applied.                                                             |
| Resolved schedule  | The duration-aware result after layer selection, content selection, boundary resolution, filler, and dead air are applied.                       |
| Preview            | A temporary resolved schedule that reports proposed selection state without committing timeline or cursor changes.                               |

### Generated output and playback

| Term                  | Meaning                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Materialized timeline | The durable rolling schedule generated from authored rules. It contains concrete timestamped segments and is output, not primary configuration. |
| Segment               | One concrete interval of primary media, filler, or dead air in a materialized timeline.                                                         |
| Dead air              | An explicit interval with no scheduled media or authored filler. It remains visible diagnostically even though playback covers it safely.       |
| Playback fallback     | Managed video looped or truncated at playout time to cover intervals that remain dead air after schedule resolution.                            |
| Playout document      | A validated daily JSON document derived from committed segments for the integrated ErsatzTV-Next channel worker.                                |
| Guide or EPG          | The human- and client-visible channel schedule derived from committed timelines. Moirai publishes it in XMLTV format.                           |
| XMLTV                 | The XML wire format served at `/epg.xml` for IPTV clients.                                                                                      |
| Channel worker        | The integrated `ersatztv-channel` process that reads Moirai-generated playout documents and produces one channel's HLS stream.                  |

## Media libraries and indexing

### Library sources

Library and source type identifiers are extensible strings. The initial source type is `on-disk`.
It recursively discovers a public list of supported video extensions beneath a configured scan
root.

The server registers library source adapters behind one scanner contract. Each adapter owns source
configuration validation, identity, normalized discovery, optional targeted presence checks, and an
optional live change watcher. The scanner manager owns provider-independent scheduling,
cancellation, progress, retry, reconciliation, and source-health publication. Only the on-disk
adapter is registered today; filesystem traversal, technical probing, path-only presence checks, and
watcher creation remain contained within that adapter.

Source identities use a provider type and stable provider-defined key, with diagnostics stored
separately. For on-disk sources, the canonical root is the stable key while device and inode remain
diagnostic details, so harmless remounts do not look like replacement sources.

Each on-disk library can define two roots:

- `scanRoot`: the path Moirai reads.
- `playbackRoot`: the corresponding path visible to the channel engine.

For example, a host can scan `/Volumes/Media/Movies` while a containerized playback process receives
the same files under `/media/movies`. Relative paths must agree beneath both roots.

Source media is managed outside Moirai. Moirai indexes files but does not add or delete them.
Preview, artwork, and playout resource resolution are still filesystem-backed. Supporting a remote
adapter will require a separate resource-access boundary in addition to implementing its scanner.

The libraries overview presents each configured source as a full-width row with a carousel of the 12
most recently indexed items. One bounded query ranks preview items within every library, including
temporarily unavailable media, without issuing a request per row. The library detail view browses 100
catalog entries per page. Its settings dialog edits the library identity, scan and playback roots,
scan cadence, watcher state, and scheduling enablement. Permanent removal stays collapsed until
explicitly disclosed, requires exact-name confirmation, and removes Moirai's configuration and index
without changing source media files.

Compact media-item cards expose a shared indexed-metadata preview on pointer hover, keyboard focus,
or an explicit touch information control. The client waits before loading incidental hover previews,
deduplicates requests, and retains successful summaries for the browser session. Preview responses
contain only bounded display metadata and never inspect or open the source media file.

### Metadata and playback facts

Kodi-compatible movie, episode, show, and music video NFO files provide descriptive metadata:

- titles, plots, release dates, and years;
- genres, studios, countries, certifications, community ratings, and user ratings;
- directors, writers, actors, and roles;
- show, season, and episode information;
- provider identifiers used for diagnostics and metadata association.

The parser accepts the compatible title, sort-title, actor-order, provider-ID, nested-rating, and
poster-reference forms emitted by maintained Kodi-style metadata exporters while preserving each
field's distinct meaning.

Portable filename parsing fills gaps when NFO metadata is absent. It recognizes the documented
movie year, provider-ID, edition, multipart, episode-coordinate, and music video track forms. Show
folder years and provider IDs remain structural disambiguation metadata rather than display-title
text. Music video libraries build artist and album groups from the documented directory hierarchy;
item metadata prefers NFO values, then embedded container tags, then filename and folder values.

NFO data is never trusted for playback-critical facts. Moirai measures the media file directly with
`ffprobe` to determine:

- duration;
- usable video streams;
- codecs and container;
- resolution;
- file size.

The same probe records embedded subtitle stream indexes, codecs, languages, titles, and default,
forced, hearing-impaired, and commentary dispositions. Sidecar `.srt`, `.ass`, `.ssa`, `.vtt`,
`.sub`/`.idx`, and `.sup` files are associated with either the logical item or a specific physical
part. Channel defaults and nested program overrides select one track using equivalent language
codes and Off, Forced, Prefer default, or Any policies. Selected embedded text is extracted to an
immutable sidecar for Burn; Convert passes the embedded stream index to the worker for WebVTT.
VobSub sidecars are probed once per track during preparation so language and disposition selection
passes a concrete stream index to the worker. Failed VobSub probes exclude only that sidecar,
leaving other subtitle candidates available. Image subtitles remain burned. Logical and part-scoped sidecar offsets follow multipart clipping.

The Playback management group owns reusable encoding profiles and credit templates. Credit templates
include descriptions and a seeded, read-only music video design protected from edits and deletion
by the server. Users can duplicate it; upgrades preserve existing templates and resolve name conflicts. Profiles
include optional descriptions, copied when duplicated from the collection or built-in viewer;
built-in presets include usage descriptions.
Description-only edits preserve linked channel settings and playback state. Encoding
profiles contain the existing audio/video normalization contracts. Linked channels retain effective
settings as persisted snapshots; profile edits atomically update those fields and publish the
existing channel-change events, so playback reads add no joins or per-channel profile queries.
Assignments validate references, names are case-insensitively unique, and deletion is blocked while
referenced. Custom channels retain independent settings, including on upgrade or when detaching a
profile. Built-in 480p, 576p, 720p, 1080p, 1440p, and 4K presets are immutable and non-deletable.
A single saved default starts at 1080p and applies only to new channels; Quick Setup and API creation
without explicit normalization use it. Explicit Custom or legacy manual API input stays independent.
Migrations preserve existing profiles and assignments, suffixing colliding built-in names.
Subtitle choices, fonts, process paths, presentation, and scheduling remain channel-owned.

Reusable music video credit templates use Liquid to generate subtitles in ASS format. They expose
bounded catalog metadata, source duration converted from persisted milliseconds, and channel resolution. Isolated, resource-limited
rendering escapes metadata text and disables file-loading tags. Generated credits take precedence
over ordinary subtitles on music videos and force channel-wide Burn mode. Source-relative cues do not restart when viewers tune in. Templates have unique
case-insensitive names and cannot be deleted while referenced; existing resources inherit disabled
subtitle/credit defaults without changing normalization or playback cursor state.
Credit references are validated without global assignment graph reads. Content and sequence cursor
fingerprints exclude subtitle preferences, preserving sequence counts, entry positions, and completion.
Channel credits or effective program credits in the prepared guide override the runtime subtitle mode
without changing the saved preference. Disabling credits restores that preference on reconciliation.
Worker configuration delivery and playout publication are serialized per channel; startup rechecks
the effective subtitle mode inside that boundary. Incompatible workers stop before replacement
playout is published and resume after synchronization. Failed restarts remain pending for
reconciliation to retry, including when a forcibly stopped worker has not yet exited;
HLS rendition metadata follows the active worker mode. No per-item worker contract change is needed.

Playback preparation batches catalog retrieval, writes content-addressed assets before publishing
playout, and records contextual per-item failures while allowing video to continue. Selected sidecars
are copied to immutable assets (including both VobSub files) and probed before publication; unreadable
or ambiguous subtitle streams are omitted. Subtitle metadata failures publish video without subtitles,
and optional asset cleanup failures do not block synchronization. Rendering runs
in two workers with at most 32 queued requests. Queue saturation omits optional credits for that pass;
reconciliation retries rendering, while interactive requests receive a retryable 503. Obsolete assets
are reclaimed only without active worker ownership, comparing canonical paths so symlinked playback
roots retain referenced files. Channel fonts folders pass through to the
worker. The built-in credit template uses Noto Sans and Noto Mono from the Docker image;
font upgrades update only the protected built-in template, preserving authored copies.
Convert playlists advertise a neutral subtitle rendition because program languages may
vary; Burn playlists omit subtitle rendition metadata.

An NFO runtime does not make an item schedulable. A new or changed file without a finite measured
duration of at most 366 days and a usable video stream remains browsable, but scheduling excludes it
and reports a scan diagnostic. This bound also prevents corrupt probe output from overflowing
scheduling arithmetic.

Successful probes are cached using the file identity, size, modification time, and probe-contract
version. Failed media probes move to the end of the scan for up to three total attempts per physical
file. Each retry pass waits for the preceding pass to finish and uses the same concurrency limit.
Recovered files retain measured metadata without stale failure diagnostics; exhausted files retain
one final probe diagnostic. Cancellation, an unavailable probe executable, and system resource
exhaustion do not trigger retries. Progress counts completed files rather than attempts and remains
in processing until deferred files settle. Pending and failed probes are also retried during startup
backfill and later scans. Probe work is globally bounded to two processes by default, with a
15-second deadline and 256 KiB output limit per attempt.

### Metadata normalization and limits

Moirai normalizes values before persistence:

- Common genre spelling aliases collapse into stable facets. For example, `Sci-Fi` and
  `Science Fiction`, `Rom-Com` and `Romantic Comedy`, and `TVMovie` and `TV Movie` share their
  respective facets. Related but distinct genres remain separate.
- Repeated metadata values and people credits are deduplicated without regard to case.
- Invalid or out-of-range numeric values are ignored and reported as scan diagnostics.
- Release years fall back from documented release fields to filename years where appropriate.
- Show groups derive an observed year range from show and episode metadata.
- Fallback sort titles omit punctuation, symbols, and leading English articles `A`, `An`, and `The`
  while preserving explicit NFO sort titles.

Each scan fingerprints the final normalized item record as well as its source files and measured
technical identity. A parser or normalization change that alters persisted metadata therefore
refreshes the indexed item even when the source file sizes and modification times are unchanged.

Multipart suffixes using `disc`, `part`, `cd`, `dvd`, or `disk` form one logical item. A valid
sequence starts at 1, is contiguous, contains at least two parts, has no duplicate part numbers, and
is limited to 128 files. Valid parts contribute one aggregate scheduling duration, which must remain
within the same 366-day bound, and play in number order. Incomplete, ambiguous, or overlong sequences
remain browsable but are excluded from scheduling. IDs of absorbed physical members remain aliases so
existing authored item references continue to resolve.

A show folder is the structural identity of a series. Provider IDs from `tvshow.nfo` remain metadata;
reusing one provider ID in separate folders produces a Status warning rather than merging the shows.

Input limits protect parser, database, and guide memory:

| Value                   |          Limit |
| ----------------------- | -------------: |
| NFO file                |          2 MiB |
| Indexed scalar field    | 512 characters |
| Plot                    |         16 KiB |
| Metadata list           |    128 entries |
| People-credit list      |    512 entries |
| XMLTV description       |          4 KiB |
| Measured media duration |       366 days |

Oversized or invalid sidecars produce a scan diagnostic. The corresponding media item can still be
indexed with filename-derived metadata.

### Artwork

The scanner recognizes conventional poster, cover, default, movie, show, folder, thumbnail, fanart,
and season artwork aliases in AVIF, BMP, GIF, JPEG variants, PNG, TIFF, and WebP. Safe local primary
artwork references in NFO files take precedence over those aliases. SVG is not served because it can
contain active content. Missing artwork uses a UI placeholder.

Artwork is transformed on demand into metadata-free JPEG variants:

- 64-pixel picker thumbnails;
- 240-pixel media cards;
- 400-pixel detail posters;
- a compatibility variant for downstream output;
- 1×, 2×, and 3× densities, capped at 1200 pixels without upscaling.

Animation is reduced to its first frame. Input is limited to 25 MiB and 64 megapixels. Four artwork
transforms run concurrently by default.

The persistent cache defaults to 2 GiB and uses least-recently-accessed eviction. Versioned cache
hits do not reopen the media source, so viewed artwork remains available during a temporary source
outage. Missing cache entries rebuild on demand. Confirmed media removals and library deletion purge
their cache directories; bounded maintenance removes orphaned entries left by interrupted work.

### Path safety

Media, sidecars, artwork, and previews must remain beneath the configured library root. Moirai opens
validated files without following symlinks and checks their identity again after opening. This
prevents a later path replacement from redirecting an in-progress NFO read, artwork transform, or
preview stream outside the library.

## Scanning and source health

### Change detection

Enabled libraries use live filesystem events as the primary change signal:

- macOS uses one recursive FSEvents stream.
- Other supported platforms use Chokidar.
- A full integrity scan runs daily while the watcher is healthy.

Events are debounced into reconciliation scans. Unsupported filesystems and watcher resource errors
switch the library to a visible periodic-scan fallback, every three hours by default, with
exponential watcher retries. A manual scan is always available. Full background scans are scheduled
from completion and are not queued behind an active scan.

Only one scan per library runs at a time. Overlapping requests are coalesced and deduplicated.
Traversal, probing, library deletion, and shutdown support cooperative cancellation. Watcher closure,
queued library operations, and active scans share a bounded cancellation grace period.

Ordinary missing items receive three healthy observations at least 30 minutes apart before removal.
After the first full scan identifies a missing item, follow-up observations check only the physical
paths stored for current tombstones. These checks verify source identity and file presence without
traversing the library, parsing metadata, processing artwork, probing media, or adding scan-history
records. A restored or inconclusive path requests a normal reconciliation scan. Large removals and
source-identity changes continue to require explicit operator approval. Large removals also receive
heal-only path checks: files found present return to scheduling immediately, while absent files are
never advanced toward deletion and remain protected behind operator approval.

### Resource pressure

Moirai protects essential work when the process approaches file, process, or storage limits. On
`EMFILE`, `ENFILE`, or `ENOSPC`, it can:

1. Suspend live watchers.
2. Pause new artwork transforms.
3. Retire idle scheduling workers.
4. Retry the essential operation.
5. Release live-status sockets only if the first retry also fails.

Active playback, SQLite, HTTP service, and logging are not shed. Optional work resumes after a
cooldown. Repeated system probe failures are coalesced into one partial-scan diagnostic.

### Missing media and reconciliation

One incomplete network listing must not erase the catalog. When an indexed item disappears:

1. It becomes unavailable immediately.
2. Moirai creates a tombstone bound to the accepted source root.
3. Ordinary deletion requires three conclusive observations at least 30 minutes apart.
4. A partial or failed scan breaks the confirmation streak.
5. A targeted check that finds the file again requests a normal scan, which clears the tombstone and
   refreshes its indexed metadata.

Large changes require explicit review. This includes:

- more than 10 missing items and more than 20% of the prior index;
- an empty result from a previously populated library;
- a configured scan-root change.

For a large removal, 30-minute targeted checks restore any suspect item whose physical path is
present without traversing the source, refreshing metadata, or probing media. Items that remain
absent still require explicit approval and are never deleted by these heal-only checks.

Candidate roots are inspected without mixing their entries into the accepted index. Acceptance is
bound to the reviewed root and manifest, so a stale confirmation cannot approve different content.
A harmless remount at the same canonical root may change device or inode diagnostics without
requiring approval, provided the paths and content remain consistent.

If the process stops during a scan, startup marks that scan failed and schedules a recovery scan for
the enabled library. Completed scan history is retained for 30 days or 2,000 entries per library by
default. Running scans are never pruned.

### Scheduling during outages

Unavailable or unconfirmed media is excluded from new selection without advancing its playback
cursor. Authored references remain intact. When the source returns, scheduling resumes
deterministically from the prior position.

A healthy recovery scan immediately rechecks dependent materialized timelines, even when catalog
rows did not change. Existing committed programming can remain available from retained metadata
during a temporary outage; newly authoritative output still requires a healthy, contiguous timeline.
Missing measured durations exclude only the affected media and retain per-item diagnostics; playable
items continue to populate the committed schedule. When changed catalog facts can refill an entirely
dead-air future caused by unavailable or unprobed media, materialization retries immediately if its
authored resources have not changed since the last commit. Unchanged empty results are not repeatedly
regenerated, and pending authored edits retain their normal application boundary.

## Persistence

SQLite stores:

- libraries and accepted or candidate source identities;
- scan runs, tombstones, reconciliation state, and catalog conflicts;
- show, season, artist, and album groups; media items and multipart aliases; genres, people,
  subtitle inventory, and technical probes;
- channels, reusable encoding profiles, and effective normalization settings;
- reusable music video credit templates;
- programs, templates, slots, boundaries, and channel template stacks;
- playback-selection state and committed timeline segments;
- playback settings.

Frequently queried metadata uses dedicated columns. Provider-specific metadata and composable
scheduling policies use validated JSON contracts. Foreign keys, WAL mode, a busy timeout,
migrations, and transactional reconciliation are enabled.

Library, program, and template names are unique by normalized case-insensitive keys. Channel names
may repeat. Channel numbers are unique under case folding because they own public stream identities.
Legacy collisions remain readable and appear on Status instead of preventing startup.

The added date of a media item is the earlier of its file modification time and first successful
indexing time.

The media-probe migration removes legacy NFO-derived durations and invalidates future materialized
output. Enabled libraries with pending probes receive automatic backfill scans. Compatibility
migrations preserve authored schedules, folder-backed show identities where they can be matched, and
persistent playback cursors.

Run one Moirai process against a local SQLite file. Replicas and network-hosted SQLite databases are
not supported.

## Scheduling model

### Authored configuration

The authored hierarchy is:

```text
Channel
  └─ ordered template stack
       ├─ conditional template layers
       └─ base template
            └─ nominal slots
                 └─ reusable programs
```

A program separates content eligibility from selection behavior. Content sources include:

- one media item;
- a hand-picked library collection bounded by the configured item limit;
- one show or season;
- a bounded set of shows or seasons;
- a library query;
- a counted, repeating sequence of other programs.

Library catalog pages can add one page-local selection or every recursively matching filtered item
to a selected-items program. The same action is available from media details. A destination can be
an existing selected-items program for that library or a newly named program with sequential,
shuffle, random, or viewing-weighted random ordering. The server canonicalizes and deduplicates item
references, appends them
atomically, and rejects the whole request when the resulting collection would exceed the configured
limit. `MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS` defaults to 5,000 and may be set from 1 through the
25,000-item
contract ceiling.

Selected-items programs retain chronological insertion batches separately from their effective order.
They default to oldest-added first and may instead order by normalized title, exact release date with
year fallback, descending variants of those automatic fields, or a manually dragged order. Descending
date-added order reverses batches while preserving request order inside each batch. Automatic title and
release ordering is derived from current indexed metadata for both review and sequential playback.
Missing release dates sort last, and stable ties retain insertion order.
The bounded program-overview carousel applies that same effective order before selecting its preview
items, so a refreshed overview immediately reflects saved automatic or manual ordering changes.

Adding more than five genuinely new items to an existing program requires confirmation of the
server-calculated addition. Duplicate references do not count toward that threshold, new programs
do not require confirmation, and a changed item set invalidates a stale confirmation without
mutating the program. Reordering the same additions also invalidates confirmation for sequential
programs, while shuffle and random programs compare additions as an unordered set.

Selection strategies include sequential, deterministic shuffle without repeats, deterministic
random selection, and deterministic viewing-weighted random selection. Weighted selection retains
baseline odds for unseen content, blends episode and show preference equally, caps preference
influence below five times baseline, and avoids an immediate repeat when another item fits.
Persistent selection state remains separate from configuration, allowing a daily slot to resume
tomorrow instead of restarting.

Newly generated timeline material avoids scheduling the same exact media item concurrently on two
channels when another candidate is eligible. The check covers primary and filler selection, rotates
channel priority by day, and falls back to normal selection rather than creating dead air when every
candidate conflicts. Already committed guide entries are never rewritten solely to remove a
collision.

The Programs catalog is searchable and filterable by content or sequence type. Content rows expose
a bounded, ordered carousel of indexed media previews, including unavailable matches; sequence rows
show their authored child-program entries. Preview data is included in the scheduling status contract
without exposing playback paths or the full scheduling catalog. A program's type, content-source
type, and source library are fixed after creation; its name, source details, and selection behavior
remain editable. Standalone program and template
editors use document-scrolling page surfaces, while editors opened inside another scheduling workflow
remain modal. Client-authored scheduling identifiers retain UUID v4 generation on non-secure LAN
origins where the browser does not expose `crypto.randomUUID()`.

For example:

```text
Program: Weeknight Mix
  3 × Cheers episodes, sequential
  1 × movie collection, shuffle without repeats
  3 × Frasier episodes, sequential
  repeat
```

Selecting shows includes their descendant seasons. Selecting seasons includes their episodes.
Overlapping selections are deduplicated, and sequential episodes are ordered by season and episode
metadata. Missing references remain authored so they can recover later.

### Templates and channel layers

A template describes one nominal local day. Slots allocate time to programs, while explicit
boundaries describe how adjacent slots resolve against real media durations.

A channel has an always-available base template. Conditional templates stack above it and can use
nested date, month, weekday, annual-range, and time-range predicates. A no-program slot is transparent:
it falls through to the next lower layer. Its slot filler is therefore disabled.

Example:

```text
Higher layer: Holiday Movies
  Conditions: December AND 12:00–17:00

Base layer: General Movies
  Applies whenever no higher layer supplies programming
```

### Boundaries, drift, and filler

Supported boundary policies are:

- `hard`: begin the next slot exactly at the nominal boundary.
- `finish-left`: allow the outgoing item to finish within finite or unlimited drift.
- `favor-right`: favor an item boundary for incoming content.

A finite `finish-left` boundary may use `favor-right` as a fallback with a separate early-start
limit. Resolution first looks for an eligible outgoing item that can finish within the ordinary late
drift. If none can, incoming programming may begin at the current item boundary only when that handoff
is within the configured early limit. Unlimited `finish-left` boundaries cannot use this fallback.
Template fallback searches also honor the slot's fit or overrun tolerance. Existing template
policies without early fallback and explicit slot truncation keep their established selection rules.

Boundary drift affects the immediately adjacent slot. The following nominal boundary remains an
anchor. Unlimited drift is valid only for finishing outgoing content and may allow that item to cross
midnight.

Example with a hard boundary and filler:

```text
17:42  Primary movie ends
17:42  Interruptible filler begins
18:00  Filler stops; next primary slot begins
```

Filler has separate selection state and never delays primary content. By default it prefers the
longest deterministic candidate that fits, then permits truncation according to its configured
policy.
Boundary rejection warnings are emitted only for time still unfilled after filler runs. A successful
primary-to-filler handoff is not a failure; partial filler coverage narrows the warning to the gap.
Fit rejection requires playable candidates that exceed the duration limit. Unavailable, unmeasured,
or missing sources retain their source diagnostics, and completed sequences do not produce false
boundary failures.

### Materialization and determinism

Saved channel schedules become durable rolling 14-day timelines in SQLite. Each commit atomically
stores:

- concrete timestamped segments;
- bounded media metadata snapshots;
- per-segment selection-state transitions;
- the continuation cursor at the end of the window.

Window rolls preserve overlapping advertised entries and generate only the uncovered tail. A restart
therefore does not reset sequential playback or reshuffle established programming.
Recovery or explicit application during dead air retains the elapsed gap up to the replacement
instant, keeping the historical guide contiguous while future programming resumes.
An early handoff at the final midnight resolves incoming next-day programming through the requested
end, including chained handoffs whose actual cursor precedes that end even when their nominal
boundaries lie later. It retains the final item's natural finish and active occurrence state for
continuation. Existing commits whose continuation falls short of their advertised window are repaired
on the next pass.
Filler fitting uses the actual incoming slot boundary, not the requested window cutoff. A filler item
that starts before the cutoff remains committed through its accepted finish. Each committed segment
can retain an internal active-slot checkpoint with its nominal occurrence, primary/filler phase,
primary progress, and deferred boundary warning. Continuation restores that checkpoint only for an
unchanged schedule at the matching cursor, preserving early handoffs across midnight and restarts.
Migration `0018_timeline_continuation` adds a nullable JSON column without changing existing entries
or selection state; older entries without a checkpoint retain the prior cursor-only resume behavior.

Timeline issues aggregate exact bounded occurrence intervals with their template, layer, slot,
program, media, and boundary origin. Partial regeneration preserves occurrences before the replacement
point, clips intervals at replacement and window edges, and replaces later occurrences. All range
comparisons use chronological millisecond timestamps, including fractional-second instants. Guide warnings and
channel schedule diagnostics use this data to open the affected date and editor section. Every
materialized dead-air segment remains visible, including authored no-program intervals, while the UI
distinguishes intentional off-air time from boundary, source, filler, and otherwise unfilled gaps.
When several warnings match a gap, its boundary rejection takes precedence over incidental
skipped-media warnings so the diagnostic action opens the relevant boundary editor.
Channel fallback filler can be reviewed and edited directly from the base schedule inspector.
Channel-card summaries and warning styling cover the next 24 elapsed hours, excluding finished gaps
and clipping ongoing gaps to their remaining duration. Counts update locally each minute and when
the page becomes visible. Cached guides are reused when their actual returned range covers the
window; otherwise the UI requests the required local dates, including daylight-saving changes.
Resource-limited partial guides show an incomplete preview instead of implying full coverage.

The public detail sample is limited to 50 occurrences per issue and rebuilt for each requested guide
range. A separate persistence-only index retains exact interval counts and boundary origins, allowing
daily rolls and mid-day replacements to partition totals and replenish diagnostic targets without
losing hidden occurrences. Older indexes preserve known origins from their detail samples and expose
unrecoverable origins as unknown rather than guessing an editor target.
Duplicate reports share generation-local identity state and an issue lookup index even after the
detail cap, avoiding repeated scans when large catalogs contain invalid media. Pre-index records retain
unlocated legacy counts conservatively until regeneration or the retained legacy window ages out;
these indexes are not sent to clients.
An aggregate ceiling of 50,000 occurrences spans every issue in a generation or merged commit,
bounding deduplication keys, detail samples, and count records together. Exceeding it rejects the
work with an actionable limit error rather than truncating counts or continuing to allocate storage.
Displaced-slot warnings retain the origin and owning layer of the boundary that permitted the overrun.
Generation records all slots consumed by the final advertised item, including those past the requested
midnight. The commit retains these deferred warnings through its continuation cursor; guide queries
still filter them to their requested range, and subsequent rolls preserve them without inventing
warnings for intervals skipped by an unrelated incremental cursor.
Disabled slot filler directs diagnostics to the template; configuring channel filler cannot override
that opt-out. Boundary deep links focus their selected control after the editor finishes loading.
Warning popovers remain open while pointer or focus transfers into their diagnostic action; Tab
reaches the action from its badge, a second Tab continues to the next guide control, Shift+Tab returns
to the badge, and Escape closes it and restores badge focus.

Configuration changes remain pending until the next local midnight by default. The schedule editor
can instead apply them after the currently playing item. Healthy catalog changes rebuild only unlocked
future output. A failure retains the last good timeline and exposes a failed status rather than
committing a partial replacement.

Preview endpoints return proposed state without committing it. Preview ranges are limited to 14 days
and 50,000 segments per channel; combined guide responses are limited to 200,000 segments. An
oversized combined guide returns the largest complete local-day range within that limit and reports
both the requested and returned day counts. Scheduling runs in a bounded worker pool with two workers
and a 32-request queue by default. Saturation returns `503` with `Retry-After`.

Catalog loading follows program references. It reads whole libraries only for library-query sources,
coalesces identical revision reads, builds reusable indexes, and retains at most 32 cached scopes.
Worker caches distinguish live preview availability from the retained availability used for committed
programming, so alternating preview and background requests cannot reuse the wrong catalog view.

## Guide and IPTV delivery

### Public endpoints

Moirai serves the client-facing outputs directly:

| Endpoint                          | Purpose                        |
| --------------------------------- | ------------------------------ |
| `GET /iptv/channels.m3u`          | IPTV channel playlist          |
| `GET /epg.xml`                    | XMLTV electronic program guide |
| Per-channel HLS URLs from the M3U | Live channel playback          |
| Feed channel logos and artwork    | Images referenced by M3U/XMLTV |

The Guide UI displays copyable channel-playlist and XMLTV URLs derived from `MOIRAI_PUBLIC_URL`.

Guide timeline and compact schedule-preview geometry use elapsed instants across each configured
local date. Daylight-saving transitions therefore render 23-hour and 25-hour days at their actual
width instead of assuming every local day lasts 24 hours.

### XMLTV

The XMLTV document comes only from the committed rolling timeline. It includes every configured
channel, explicit no-programming intervals, bounded metadata snapshots, episode data, and proxied
artwork where available.

Channel identifiers use this stable format:

```text
C<channel-number>.<short-channel-id>.moirai.tv
```

For example: `C601.1.a1b2c3d4.moirai.tv`.

Every XMLTV icon URL contains a source or channel version query parameter so clients can refresh
changed artwork without disabling caching. Conditional requests use ETags. Only committed timeline
or channel-presentation changes invalidate the cached XMLTV document.

A scheduled channel must have a healthy, contiguous committed window before its guide and playback
are authoritative. Incomplete output returns a retryable unavailable response instead of pretending
the gap is intentional dead air.

### ErsatzTV-Next integration

Moirai owns channel configuration and maps it through a compatibility adapter pinned to ErsatzTV-Next
revision `4eec042fc847aac3799b1d1ab27a4d20f4984575`. The adapter retains only the channel and playout
schemas used by the integrated worker; vendored files retain upstream MIT attribution.

New channels default to Moirai's `Automatic` hardware-acceleration setting. Immediately before
playback, Moirai runs bounded one-frame FFmpeg encoder probes for the configured codec, bit depth,
and output dimensions, preferring discrete devices and then platform-integrated backends. The
verified result is converted to a concrete ErsatzTV-Next acceleration value; if no compatible
encoder is found, playback receives `None`. Editor predictions use the same server-visible probe and
five-minute bounded cache. Automatic probes support 8-bit and 10-bit targets through 8K UHD, while
explicit backend selections remain available for other configurations. Existing channels that store
`None` are not migrated. Distinct probes share a bounded queue whose eight-second deadline includes
queue time. Indeterminate results and source-sized outputs are not cached, allowing playback to retry
before safely falling back to `None`.

The adapter produces validated, non-overlapping playout documents for each local calendar day. It:

- respects DST-shortened and DST-lengthened days;
- splits media crossing midnight while preserving source offsets;
- maps primary and filler content to playback-visible local paths;
- expands multipart logical items into sequential physical playout entries;
- expresses truncation and resumed fragments with millisecond offsets;
- replaces every remaining uncovered interval with channel, global, or bundled fallback video.

Playback fallback is separate from authored schedule filler. A channel-specific managed upload wins
over the global managed upload, which wins over Moirai's immutable bundled `dead-air.mp4`. Each
observed continuous gap begins at source offset zero. When the rolling boundary advances inside a
gap, regeneration derives the source offset from the materialized interval start; a guide with no
segments instead uses a fixed epoch anchor. The selected file
is truncated for a shorter gap or looped for a longer gap, with source position preserved when daily
files split at midnight, cross a DST transition, or are regenerated after the rolling window advances.
Moirai supplies stereo 48 kHz silence when fallback video has no audio stream. The
adapter uses bounded local-source fragments so tuning never requires a long seek, while the resulting
daily document still covers every instant without gaps or overlaps.

Each managed scope owns one private asset and metadata pair. Replacements are streamed, probed, and
staged together before the complete active directory is replaced with rollback protection. Startup
restores the prior pair if replacement was interrupted. Uploads must contain exactly one video stream,
and that stream must have a measured duration of at least one minute; a longer audio or container
duration cannot satisfy this minimum. The minimum does not constrain authored schedule filler such as
short commercials.
Invalid or missing overrides fall through to the next source while remaining visible as management
warnings. Settings owns the global override; each channel editor owns its optional channel override.
Removing either override cannot alter the bundled final fallback. A fallback change briefly restarts
only affected active channel workers after their playout files synchronize; inactive channels remain
stopped. Global fallback changes synchronize every channel, while channel override changes synchronize
only their owning channel without invalidating channel configuration or the EPG. Startup reconciliation
removes managed fallback state owned by deleted channels. Removal keeps the old file available until
affected workers have stopped and their inherited playout has been attempted. Replacement stops affected
workers before the fixed asset path changes. A validated storage change remains committed if later
playout synchronization or restart fails; the failed worker stays stopped and normal synchronization or
the next tune retries recovery.

Moirai writes playout files atomically before an active worker can read them. The standalone
`ersatztv-channel` process starts on demand and writes HLS into a private runtime directory. No separate
`ersatztv` server, `lineup.json`, or lineup reload is required.

An active worker retains its startup normalization and channel settings. Relevant changes mark the
session stale; the Status page provides an explicit restart so the operator chooses when to
interrupt viewers.

The default limit is four concurrent channel workers. Workers update private heartbeats as clients
request playlists and segments, and the pinned engine exits inactive sessions. Child output is
bounded, filenames and paths are validated, and shutdown terminates process groups within the
configured grace period.

Active-session status records the concrete encoder observed in each worker's optimized FFmpeg
pipeline. It also retains at most 16 recently active client identities per shared channel worker,
using the direct address and bounded User-Agent visible to Moirai. Client observations expire after
the worker's 90-second heartbeat window and are never persisted. For active workers, one additional
batched timeline query identifies the committed item occupying the current wall-clock position and
uses its captured artwork reference. The Status page shows that poster, advances the item's position
locally, refreshes at its finish boundary, follows playback events, and periodically reads the
non-cacheable status resource so session starts and stops recover even when a live event connection
is interrupted.

When local viewing preferences are enabled, each approximate client and media encounter must remain
active for two minutes before it is recorded. The initial item in a tune session contributes two
points and later items contribute one. Only media and show references, encounter type, points, and
time are persisted; network addresses and User-Agents are not. Effective scores use a 180-day
half-life, and negligible events are pruned after two years. Administrators can inspect the strongest
decayed preferences, disable both collection and application, or permanently clear the history from
Settings. Preference changes affect only timeline days subsequently appended to the committed
14-day window.

### Development and production engine builds

Native development resolves the channel engine in this order:

1. `MOIRAI_ETV_CHANNEL_PATH`.
2. A checkout selected by `ETV_NEXT_DIR`.
3. The pinned `vendor/ersatztv-next` submodule build.
4. `PATH`.

Useful commands are:

```sh
npm run etv:setup  # Initialize the pinned development checkout
npm run etv:build  # Build the standalone channel worker
npm run etv:check  # Compare schemas and revision with the selected checkout
npm run etv:sync   # Deliberately refresh the compatibility snapshot
```

The production image derives from the immutable official ErsatzTV-Next image digest recorded in the
Dockerfile and builds the Node application around its `/app/ersatztv-channel` executable. The pinned
upstream image currently supports `linux/amd64` only. The development submodule is excluded from the
Docker build context.

## API and web application

### API boundaries

Fastify exposes a versioned `/api/v1` JSON API. Zod schemas validate domain inputs and outputs.
Expected failures use safe, consistent error bodies. Unexpected failures return a generic message and
request ID; complete diagnostics remain in server logs.

Management routes require one opaque administrator-session cookie by default. Explicit public
exceptions cover authentication entry points, health probes, IPTV delivery, XMLTV, and the bounded
logo and artwork resources referenced by those feeds. Playback status, client identities, logs,
media previews, management reads and writes, and the live-event WebSocket require authentication.
The API does not grant cross-origin browser access. Unsafe requests additionally require an allowed
application origin and the authenticated session's `X-Moirai-CSRF` synchronizer token. The generated
OpenAPI security requirements identify both the session cookie and this header on protected writes,
and protected operations document the `401` and applicable `403` failures enforced by the shared
guard.

The same route registrations generate an OpenAPI 3.1 contract for every HTTP operation, including
XMLTV, M3U, HLS, artwork, media preview, and log downloads. The versioned `/api/v1/events` payload
union generates a separate AsyncAPI 3.1 contract. `npm run docs:api` validates both contracts and
writes JSON, YAML, and self-contained HTML to the ignored `dist/api-docs/` directory. Generation uses
inert service dependencies, so it does not open SQLite, scan media, or start playback. Documentation
is a development artifact and is not mounted as a production server route.

Health endpoints have separate meanings:

- `/api/v1/health` and `/api/v1/health/live` are dependency-free liveness checks.
- `/api/v1/health/ready` checks SQLite and essential background services.
- Readiness reports non-blocking source warnings but returns `503` when authoritative operation is
  degraded.

Docker uses readiness for its container health check.

### SPA architecture

Vue 3, Vite, Vue Router, and Pinia provide the management SPA. Major views include:

- library configuration, browsing, health, and reconciliation;
- media details and best-effort in-browser file preview;
- channel normalization and artwork;
- a Playback group for reusable encoding profiles and music video credit templates;
- guided Quick Setup for movie, show, and music video channels;
- reusable Programs and daily Templates;
- layered Channel Schedules;
- channel and dedicated EPG guide views;
- administrator account and local fallback credential management;
- playback, status, and log views.

The primary Status navigation item also carries the live IPTV readiness state and active channel
count without a separate sidebar card.

Route state preserves sorting, filters, hierarchy, pagination, and within-page catalog anchors so
browser back and forward navigation restore the same view. Loaded stores retain prior data when a user
returns to a page; initial empty collections have explicit loading states.

Disclosure and navigation-section expansion preferences are stored per section in browser local storage;
storage failures leave controls usable. Choosing Custom encoding still opens its controls.

Session expiry preserves one internal return destination and leaves authentication pages in place
when further unauthorized requests arrive. Sign-in unwraps older nested authentication destinations
with a bounded depth, preserves the final query encoding, and rejects external return addresses.

Library catalog pages window responsive rows with bounded overscan. Full-width section headings and
unmounted title or genre anchors retain virtual positions so sticky navigation can scroll directly to
them without rendering every card on the page.

The library filter presents genre rules first and defaults to Match all, where each genre can be
neutral, required, or explicitly disallowed. Its contextual facets predict the result of either
action. Match any retains simple inclusion checkboxes and static library totals. Additional filters
cover title, release and indexed dates, minimum indexed popular and user ratings, actors, and
directors. Items without the selected rating value do not satisfy a minimum-rating filter.

Media preview supports `GET`, `HEAD`, and one HTTP range, which permits scrubbing when the browser
supports the source container and codecs. Moirai does not transcode preview files.

### Bundled user documentation

The `@moirai/docs` VitePress workspace builds a task-oriented, version-matched administrator guide.
The runtime image places its normal `.html` output under the SPA distribution at `/help/`. Help
pages, their contextual manifest, and screenshots are public so setup and recovery guidance remains
available before authentication. Unknown `/help/` paths return the guide's 404 page instead of the
management SPA.

The Vue application maps management routes to stable topic IDs and presents restricted rendered
Markdown in an accessible modal drawer. The public `/help/contextual-help.json` manifest contains the
matching full-page path and review state. Vite development serves the generated manifest and source
screenshots directly from the docs workspace.

Each authored page is hashed from normalized Markdown and every referenced local screenshot. A
versioned registry records explicitly approved digests and timestamps; prose, link, or screenshot
changes therefore return the page to `needs-review`. Drafts remain visible in normal builds with a
warning, while `build:production` and Docker builds reject any outstanding review. The generated
`/help/review.html` dashboard and `docs:user:review:list` command expose the review queue.

Channel logos can be safe external HTTP(S) URLs or managed PNG files. Managed uploads support an
unconstrained crop and never upscale beyond the source or channel resolution. Browser and server
limits are 4096 pixels per edge and 10 MiB encoded output; source selection is limited to 25 MiB and
64 megapixels. The server fully decodes and normalizes PNG data before storing it atomically.

Quick Setup presents presets on a normal page; choosing one opens its library step in a
resource-editor modal with a shared close header, scrolling steps, persistent
navigation actions, and draft confirmation for close, backdrop, Escape, and route changes. It can
reuse a compatible library or create one and immediately begin its asynchronous
initial scan. Dynamic queries remain valid while that scan is empty, while explicit item, show, and
season choices appear as the index fills. Library queries show every currently indexed match through
an incrementally loaded, horizontally windowed carousel and refresh the loaded range after
programming-affecting scan events. Quick Setup and the full Program editor share the library catalog's
title, release-year, indexed-date, rating, actor, director, and include/exclude genre filters. Dynamic
queries can order matches by title/episode, indexed date, or release date in either direction and
optionally limit the resulting ordered set before excluding unavailable or unmeasured media, so
playback never substitutes items outside the previewed limit. Programs evaluate those choices
against each refreshed scheduling catalog without per-item queries.
Playback-state identity treats omitted and explicit query defaults equally, preserving legacy
sequential cursors and shuffle progress when a name-only edit saves the newer fields.
Review presents four full-width rows with capped 12-item library and source samples, prepared channel
branding, and a resolved sample day in the server timezone. The read-only Quick Setup preview endpoint
shares resource construction and source validation with creation, runs in the scheduling worker pool,
and persists neither resources nor playback state. Samples remain illustrative while indexing and
randomized playback can change output; preview errors do not block valid creation. Completion morphs
the dialog surface to a compact content-sized layout without scaling text, with immediate sizing for
reduced motion. Both logo preparation paths and server PNG normalization preserve alpha transparency.
Final submission atomically creates a content program, a
single-slot daily template with a persistent cursor and unlimited finish-left midnight boundary, a
channel using the saved default encoding profile, and its base assignment. A new library remains
independent of that transaction because scanning may already be active. Optional local artwork is
fitted without cropping and uploaded afterward; a failed upload leaves the playable core setup
intact and can be retried from the completion screen.

### Live events

`/api/v1/events` is a bounded, versioned WebSocket stream. It reports:

- connection readiness;
- library, watcher, and scan changes;
- scheduling and committed timeline changes;
- playback changes.

Events are hints, not the source of truth. The SPA reconnects transient failures with backoff and
reloads authoritative REST state after connection. Events are not replayed. Slow clients are
disconnected, payload sizes are bounded, and concurrent live connections are capped. Browser upgrade
origins are validated, and each connection closes with policy code `1008` when its associated
administrator session is revoked or expires. The SPA treats that closure as terminal, clears its
authenticated state, and returns to sign-in instead of reconnecting with stale credentials.
Credential replacement gives the initiating connection private-use close code `4001` so it
reconnects with the replacement cookie, while other sessions revoked by that change receive terminal
`1008`. A local session reaching its previously known deadline is revalidated against its sliding
database expiry before the socket closes. An abnormal connection failure first checks the public
session-state endpoint, so a rejected authenticated upgrade ends stale UI state instead of entering
an unbounded reconnect cycle.

Guide consumers coalesce refreshes for reconnects, channel presentation, scheduling, committed
timeline, and programming-affecting scan events. Watcher-status and playback-session noise does not
invalidate guide data.

## Logging and operations

Server logs are redacted, structured JSONL files beneath the persistent data directory. Defaults are:

| Setting             | Default |
| ------------------- | ------: |
| Retention           | 14 days |
| File rotation       |  10 MiB |
| Total retained size | 200 MiB |

Log and artwork megabyte settings are accepted only when they convert to finite, positive,
safe-integer byte counts. Invalid and overflowing values use their documented defaults.

The Logs view provides bounded search, cursor pagination, live refresh, one-line request entries, and
structured details on demand. It pairs request-start and request-complete records to show method,
endpoint, source IP, status, and duration together. Routine polling of log-reading endpoints suppresses
only automatic access records; failures and file downloads remain logged.

The server is assembled from domain-owned artwork, guide, media, operations, playback, repository,
route, scanner, and scheduling modules. Persistence remains behind one repository facade, while the
server source root contains composition, bootstrap, configuration, documentation generation, and
cross-cutting primitives. Scheduling views compose focused editor components. Styles are
feature-oriented Sass partials, and automated tests mirror production paths under the root `tests/`
directory.

## Security and deployment assumptions

The first visitor initializes full administrator access with either a singleton local account or a
configured Logto traditional-web application. An OIDC-first installation can add local fallback
credentials later. Anonymous local registration closes atomically after either method initializes
the installation. Until that happens, the instance is intentionally claimable; development binds to
loopback and operators must not expose a new deployment before initialization.

Local passwords are 15 to 256 characters and use salted Argon2id hashes. Authored username spelling
is retained separately from its NFKC-normalized, case-insensitive comparison key. Random local
session tokens are stored only as hashes, expire after 30 inactive days, and travel in HttpOnly,
SameSite cookies that become Secure under HTTPS. Active local sessions retain their unpredictable
bearer while extending the durable and browser inactivity deadlines at most once per day.
Credential changes do not alias the revoked bearer to its replacement; the browser fences overlapping
requests so their stale failures cannot discard the replacement response. Credential changes and
operator-issued, single-use recovery codes atomically persist replacement credentials and their new
session while revoking prior local sessions. Local login and ordinary credential replacement compare
the exact password-hash version that was verified inside the same SQLite transaction, so an
overlapping reset cannot leave access authenticated by superseded credentials. Concurrent attempts to
add the singleton local fallback return a controlled conflict without revoking the losing OIDC
session; recovery authority can still replace the winner. Recovery validates its unpredictable
operator token before admitting memory-hard password work, then consumes that authority atomically.
Login and recovery attempts are throttled per client so a guessed username cannot lock out other
addresses, while current-password verification is bounded per identity. Concurrent memory-hard
password work cannot exceed the native worker-pool capacity. Session persistence retains at most 32
sessions per identity and 1,024 across the installation, evicting and disconnecting the oldest when a
new session crosses either limit. Public resources bypass session resolution. Reverse proxies must be
explicitly trusted by IP or CIDR before forwarded client addresses affect authentication throttles.
Management and authentication-sensitive responses prohibit shared caching, and browser responses
deny framing to prevent UI redressing from another origin.

Recovery remains reachable from an authenticated browser so a Logto administrator can replace lost
local credentials. Its single-use token stays in the URL fragment until the initial session-state
request succeeds, preventing a transient bootstrap failure from destroying the reloadable recovery
link.

Logto uses discovery plus Authorization Code flow with PKCE, state, nonce, and a short-lived HttpOnly
browser-binding cookie. Provider subjects are scoped by issuer, provider logout hints are encrypted,
and validated back-channel logout tokens revoke a named provider session or fall back to all sessions
for a subject. Each authorization start captures a durable generation so its callback is rejected when
crossed by logout, while bounded, expiring token fingerprints make provider retries idempotent. OIDC
starts are rate-limited per client, callback exchanges and logout verification each have an
eight-operation concurrency cap, expired redirect state is pruned on insertion, and at most 256 live
transactions are retained globally. Logto-backed Moirai sessions have an absolute 24-hour lifetime
and cannot slide beyond it. They are bound to a hash of the provider endpoint and application ID, so
disabling Logto or changing that application configuration revokes them at the next server start;
rotating only the application secret does not. Any identity accepted by the configured Logto
application receives the same full access; Moirai has no roles or variable permissions.

The public URL remains the OIDC callback and media-delivery origin. A separate management URL owns
browser-facing setup, recovery, callback-return, and post-logout links. It may select another port on
the same scheme and hostname so split Vite development reaches the browser UI without changing cookie
scope or enabling an open redirect. The recovery command uses a bounded Vite-specific probe when no
management variable was supplied. Non-loopback development origins bind Vite externally while its
host allowlist remains restricted to the configured management hostname.

External channel logos must be credential-free HTTP(S) URLs no longer than 2048 characters. Unsafe
stored values are omitted from generated output. Channel numbers cannot be relative path segments
because they participate in public stream paths.

`MOIRAI_PUBLIC_URL` must be reachable by IPTV clients. The UI reports a prominent warning while the
loopback default is in use.

The Docker deployment uses one writable persistent data mapping and read-only media mappings. The
integrated playback worker runs inside the same container and must see each configured playback root.

## Current boundaries and deferred work

The current architecture deliberately does not provide:

- roles or variable administrator permissions;
- media-server providers such as Jellyfin, Emby, or Plex;
- template rotations and seasonal rule types beyond the current predicate stack;
- a network or replicated SQLite deployment;
- browser-preview transcoding;
- arbitrary ErsatzTV filter controls.

These features can be added above the existing provider, calendar-rule, persistence, and adapter
boundaries without making the materialized timeline the editable source of truth.
