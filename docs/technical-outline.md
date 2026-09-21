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
or an explicit eye-icon preview control with centered artwork and a 44-pixel mobile touch target. The client waits before loading incidental hover previews,
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
text. Music video libraries retain artist and album groups from the documented directory hierarchy.
Otherwise ungrouped songs receive artist/album groups from normalized metadata, using the first
credited artist, then folder fallbacks and explicit unknown groups. Grouping runs during discovery
without extra browse queries; metadata version 11 refreshes existing indexes on their next scan.
Existing folder-group IDs, song IDs, playback paths, and program selections remain stable. New groups
use canonical comparison keys while preserving display spelling. Item metadata prefers NFO values,
then embedded container tags, then filename and folder values.

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

The Playback management group owns reusable encoding profiles, credit templates, and XMLTV
guide templates. Credit templates
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
Background read failures are discarded when superseded. Schedule summaries retry transport or
502/503/504 failures twice on visible one-minute checks, retaining covered cached previews;
validation and resource-limit responses do not trigger automatic retries. Playback status coalesces
reads and separates conflict-report failures from playback recovery, retaining the last update time
and escalating after three failed reads. Encoding-profile and credit-template saves apply returned
resources immediately; their follow-up collection reads retry a transient failure once without
repeating mutations. Credit previews report unavailable duration without inferring scan state and
refresh their sample on completed music scans while preserving the draft and available selection.

Guide and Channels views check the scheduling date every minute and when a tab becomes visible.
Guide requests clamp past start dates to today and discard expired navigation history, preserving
future selections. Same-day checks do not issue network requests.

The channel editor checks canonical number conflicts locally against the loaded channel list,
excluding itself, and shows up to three prefix matches. Existing groups supply autocomplete
suggestions without additional queries. Server-confirmed channel saves update the shared list
immediately and invalidate older catalog requests; lineup and guide refreshes run in the background. Numeric fields request mobile numeric keyboards; compact
resource-editor footers retain accessible action names and reset confirmation with icon controls.
Successful template and channel-schedule saves close their editors, including saves requested
through the unsaved-changes dialog; failed saves preserve the open draft.

Reusable XMLTV guide templates use Liquid to generate `<channel>` and `<programme>` fragments, with
a tab per listing kind. Interpolated values are XML-escaped and file-loading tags are disabled.
Blank tabs and invalid live sources fall back to the built-in Standard XMLTV layout for that kind.
A single default applies to channels without an explicit assignment. Used by includes channels that
inherit the current default as well as channels that assign the template explicitly. Editor preview
shows one local day as a guide at four-hour zoom from unpublished sources; published XMLTV is
minified. Completely empty tabs fall back to the built-in layout for that kind; a tab that still
contains comments or other Liquid is used as written.

Reusable music video credit templates use Liquid to generate subtitles in ASS format. They expose
bounded catalog metadata, source duration converted from persisted milliseconds, and channel resolution. Isolated, resource-limited
rendering escapes metadata text and disables file-loading tags. Generated credits take precedence
over ordinary subtitles on music videos and force channel-wide Burn mode. Source-relative cues do not restart when viewers tune in. Templates have unique
case-insensitive names and cannot be deleted while referenced; existing resources inherit disabled
subtitle/credit defaults without changing normalization or playback cursor state.
Draft previews offer at most 12 available catalog music videos in newest-added order and use the
saved default encoding profile’s video geometry with system fonts, without requiring a channel.
The still-image preview does not encode audio. Explicit legacy preview channel IDs remain supported.
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
are opened against the configured library playback root (falling back to its scan root), rejecting
symlinks, canonical root escapes, and nonregular files. Both VobSub members are validated before
copying; immutable snapshots are streamed from those descriptors and probed before publication.
Versioned cache keys prevent reuse of snapshots created before this boundary check. Unreadable
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

Playback and scheduling duration use the longest valid video-track duration, accepting native
stream durations or Matroska duration tags. Container, audio, and subtitle durations never supply
a fallback. Scans report a per-file warning when any measured audio track differs from the video
duration by more than thirty seconds, including on cached scans, without excluding the item.
The library warning banner displays at most ten issues inline; a dedicated dialog shows the full list.
Before consulting visual caches, each scan suppresses a duration finding when all measured audio
tracks are at least 95% of the video duration and at most thirty seconds longer. Equality qualifies;
unknown audio durations are not measured tracks. This rule does not depend on alignment or start
offsets and reports within-duration-tolerance. Existing visual caches remain available for fallback.
For larger differences, audio tracks ending within thirty seconds of one another, all before a single non-artwork video
stream ends, are eligible for silent-tail assessment when the earliest audio ends more than thirty
seconds before the video duration. FFmpeg decodes every frame after the earliest audio ending,
requiring at least 90% black pixels in every frame throughout the tail and complete decoded coverage
before suppressing a finding. The pixel darkness threshold remains 0.03. This visual heuristic
includes sparse white credits but does not identify credits or establish audio completeness.
The shared probe queue bounds concurrency; decoding is single-threaded, limited to 120 seconds of
source, 30 seconds of wall time, and 1 MiB per output stream. Files are opened through validated
inherited descriptors and their identities checked before and after inspection. Missing timing,
multiple video tracks, nonqualifying frames, excessive tails, and failed inspection never qualify for
visual suppression.
Migration 0034 adds physical-file assessments keyed by library and relative path.
Migration 0035 clears unaccepted not-black and uncertain cached results for reassessment on the next
scan, preserving manual acceptance, prior black results, and scan history. New qualifying results
use mostly-black; legacy black results remain supported. One batch read
per scan loads cached outcomes; reconciliation persists them transactionally in bounded batches.
Migration 0036 adds ignored_media_issues keyed by library, normalized relative path, and issue code,
migrating explicit silent-ending acceptance without changing cached results or historical scans.
General ignore decisions are authoritative; the legacy acceptance endpoint and field remain compatible.
Media fingerprints use physical identity; metadata uses relevant media/NFO inputs and sidecar absence;
Multipart decisions include ordered member identities; show conflicts include participating metadata.
Unavailable inputs include observable identity and stable availability state rather than error messages.
One decision read per reconciliation applies decisions transactionally with health counts and scan
history. Complete scans expire resolved decisions; partial scans retain unobserved decisions. Changed
inputs and accepted source replacement invalidate decisions, independently of scan-history pruning.
The shared eligibility allowlist excludes directory/source failures, global probe resource/executable
failures, lifecycle diagnostics, source approvals, and removal reconciliation. Ignoring changes only
attention counts and presentation, never playability, scheduling eligibility, or catalog conflicts.
The library-scoped media-issue operation validates the latest finding and fingerprint, rejecting stale
requests, active scans, and candidate sources. The full issues dialog offers Ignore issue and manually
ignored findings offer Restore issue under Suppressed issues, accessible from both Show all issues
and Last scan. Automatic suppressions have
no manual override. Restoration removes the explicit ignore immediately; subsequent scans may apply
automatic suppression again. Live library events refresh the transactionally updated health state.
The additive scan-issue contract exposes ignoreState alongside the compatible tail assessment.
Probe contract version 6 refreshes older cached durations on the next library scan.

An NFO runtime does not make an item schedulable. A new or changed file without a finite measured
video duration of at most 366 days and a usable video stream remains browsable, but scheduling
excludes it and reports a scan diagnostic. This bound also prevents corrupt probe output from overflowing
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

Multipart suffixes using `disc`, `part`, `cd`, `dvd`, or `disk` form one logical item only when
preceded by a nonempty name prefix. Bare names such as `Disc 2.mp4` remain standalone videos. A valid
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
landscape, and season artwork aliases in AVIF, BMP, GIF, JPEG variants, PNG, TIFF, and WebP. `thumb`
and `-thumb` remain last-resort poster aliases. Poster, landscape, and fanart files are stored
independently; the primary artwork path remains poster, then landscape, then fanart. Safe local
primary artwork references in NFO files take precedence over those aliases. SVG is not served because
it can contain active content. Missing artwork uses a UI placeholder. The public artwork endpoint
accepts an optional `role` of poster, landscape, or fanart. Group poster requests fall back to the
primary artwork path when the dedicated poster column is empty. Guide listings use that poster URL,
or the primary `artworkUrl` on older media snapshots that predate role fields.
Artwork cache entries isolate each role, including stale fallback and replacement cleanup;
requests without a role retain the existing primary-artwork cache paths.

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

Confirming removals retires the current scan's removal warning without clearing unrelated issues.
The library attention banner omits resolved removal diagnostics, including stale alerts left by
older versions; historical scan issues remain unchanged.

Candidate roots are inspected without mixing their entries into the accepted index. Acceptance is
bound to the reviewed root and manifest, so a stale confirmation cannot approve different content.
A harmless remount at the same canonical root may change device or inode diagnostics without
requiring approval, provided the paths and content remain consistent.

If the process stops during a scan, startup marks that scan failed and schedules a recovery scan for
the enabled library. Completed scan history is retained for 30 days or 2,000 entries per library by
default. Running scans are never pruned. The library’s Last scan status block opens a scrollable
scan-history dialog with results, counts, and retained issues. Catalog pagination stays pinned
to the viewport bottom on desktop and mobile, with space reserved below the media list.

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
- reusable XMLTV guide templates and the single default assignment;
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

Library search uses a separate optional `search` parameter; the existing `name` filter remains
title-only. Catalog search uses an FTS5 prefix index of titles, plots, genres, people, and group labels,
kept in sync from catalog writes, and flattens to matching items so a shows-library query can return
every matching episode. Live FTS triggers skip artwork-only item updates and group updates that do not
change searchable text; scan persist defers those triggers and rebuilds `catalog_search` once for the
library. Library listings read a stored `item_count` updated at scan commit instead of counting media
rows on every request. The web shell ignores in-progress `scan.changed` events when refreshing the
library list. When prefix matching finds nothing, the same filters fall back to substring
`LIKE` so queries such as `ein` still match `Seinfeld`. Music-video libraries keep credit and album matching, including
Unicode folding. Search results skip A–Z navigation aggregation. Catalog and source-picker item
searches share those predicates. Search
results carry optional match reasons, resolved in page-bounded batches only while searching;
cards share the same formatter and virtualized rows account for the extra explanation line.
Recursive Add All selection applies the same search and filters as browsing. Music-video Artist
and Album filters are shared by Library, Programs, and Quick Setup and evaluated against the same
credits and hierarchy labels in SQL and scheduling. Music matching shares Unicode lowercase
conversion across SQL, explanations, and scheduling, preserving accents and literal punctuation.
Absent filters preserve saved selection state;
these additions need no database migration or rescan.

Library catalog pages can add one page-local selection or every recursively matching filtered item
to a selected-items program. Catalog cards also expose a single-item or single-group add control
that opens the same destination dialog without entering selection mode. The same action is
available from media details. A destination can be
an existing selected-items program for that library or a newly named program with sequential,
shuffle, random, or viewing-weighted random ordering. The server canonicalizes and deduplicates item
references, appends them
atomically, and rejects the whole request when the resulting collection would exceed the configured
limit. `MOIRAI_MAX_EXPLICIT_MEDIA_ITEMS` defaults to 5,000 and may be set from 1 through the
25,000-item
contract ceiling.

Group artwork falls back to the immediate parent poster when the group has no artwork, consistently
across catalog browsing and program source pickers, without additional database queries. During music
video scans, artists without artwork inherit the first album poster in stable source order, falling
back to the first song poster only when no album artwork exists. The selected source fingerprint
also versions the artist artwork cache; rescans recompute the fallback when artwork changes.

Hierarchy browsing also supports page-local show, season, artist, and album selection. Group and
item selections remain separate, with an explicit kind selector on mixed pages. Recursive item
additions remain available on group-only pages as Add All Items. Group additions
create or atomically extend same-library selected-groups programs, deduplicate identifiers, validate
library ownership, and enforce the 1,000-group contract limit. New programs default to sequential
playback. Group references retain dynamic descendant membership; selected seasons play in episode
order without including unselected seasons. Failed saves retain the destination dialog. Music group reconciliation preserves existing IDs when
metadata-owned artist/album groups acquire matching folders; repeated scans retain those owners
without rewriting authored program references or adding database queries. Reconciliation indexes
stored music groups by ID, source key, and parent-scoped identity once per scan; claimed owners are
removed from lookup buckets to preserve first-match precedence and ambiguity checks without
repeated catalog-wide searches.

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

Theme programs (`theme`) rank playable media from an explicit target library against a required,
trimmed theme of up to 500 characters. Optional library filters reuse the Library Query validation and
in-memory metadata matcher before semantic ranking, for both previews and new sets, without extra
database queries. Existing themes without filters retain their library-wide scope; filter edits do not
rewrite committed sets. The editor orders target library, filter configuration, theme, then refinements.
Theme programs share the semantic refinements, previews, retries, rotation, and immutable set lifecycle
below. Theme text uses the persistent concept-vector cache;
saved themes are retained during draft eviction. Catalog and embedding reads stay scoped to reachable
Programs and their libraries. Theme target libraries also contribute media and library attributes to
timeline change detection, so corrected runtimes stage regeneration at the normal application boundary.
The existing semantic preview/retry routes accept either configuration,
and the existing seed storage retains the originating configuration without a schema migration.

Similar Items programs (`similarity`) reference only Content programs with explicit item collections.
Update validation rejects changes to the saved source Program ID before persistence; source contents
and similarity settings remain editable.
They rank playable same-library, same-kind candidates using normalized BGE-small-en-v1.5 embeddings,
excluding source items. Optional library filters share Theme’s candidate matcher and validation,
without filtering the source anchors or adding scheduling queries. Missing filters preserve existing
behavior; edits apply to the next immutable set. The editor exposes a collapsed Additional filters
section after Source Program and loads genre choices on demand. Semantic text includes title, kind,
plot, genres, tags, and episode/music ancestor context, never paths or technical metadata. Input schema v2 budgets actual tokenizer output
within 510 content tokens (plus two special tokens), reserving 256 for the item overview, 64 for
identity, 96 for metadata, and 94 for ancestor context. A schema change regenerates cached vectors
asynchronously; committed sets remain immutable. A pinned Transformers.js CPU ONNX child process
uses CLS pooling, one inference thread, local-only assets, bounded batches, and idle/pressure retirement.
Process isolation allows the native runtime to reload safely after each retirement.
Every server build acquires and verifies immutable model artifacts and packages them, with the license,
in `apps/server/dist/embedding-model`. Docker copies that complete output, and native deployments
must retain it. Runtime resolves the bundle relative to the server module, independently of the working
or data directory; remote model loading is disabled and no runtime download fallback exists.
Verified existing build assets (or the previous local development cache) allow offline rebuilds.
Startup and catalog events backfill SQLite float32 vectors without a rescan, invalidating model,
input-schema, or semantic-text changes. Failed inputs remain distinguishable from pending work. The editor's explicit retry operation
requeues only failed relevant media and current refinement identities for one attempt; ready vectors
and committed seeds remain unchanged. The request wakes media reconciliation and invalidates the
scoped catalog cache.

Deterministic MMR blends centroid and maximum-anchor relevance equally, with variety lowering the
relevance weight from 1 to 0.55. A fixed 0.15 relevance band and positive anchor similarity constrain
exploration. New sets prefer candidates absent from the last ten completed sets, then the least-recent set
represented in that bounded history before applying MMR. History travels in optional timeline cursor
state, survives pruning/restarts, and defaults to empty for older cursors. Replayed seed decisions
remain unchanged. Relevance maxima use reductions rather than argument spreading for large pools.
Optional soft preferences use the same local worker and a model-keyed SQLite prompt cache. Within
that fixed source-relevance band, ranking blends 70% source relevance and 30% preference similarity
before MMR. Semantic exclusions compare each candidate with every excluded concept and remove matches before
ranking. Strictness 0–100 lowers the cosine cutoff linearly from 0.8 to 0.5 (default 50 / 0.65).
This is an approximate semantic boundary, not a classification guarantee. The existing `hardExclusions`
wire key now stores semantic concepts; saved entries adopt this behavior only for future seed decisions.
Exclusions share the model-keyed prompt cache, and pending or failed concept inference blocks new
sets instead of silently ignoring filters. The editor previews both remaining and excluded candidates. Draft previews enqueue preferences asynchronously
and never commit seeds. Preference preparation/failure is visible through existing embedding events.
During library backfill, each batch of at most 20 media inferences is followed by up to 20 queued
refinement inferences, so new editor requests do not wait for the complete library pass and neither
queue monopolizes inference.
Migration 0032 adds the preference cache without rewriting media embeddings or committed seeds.
Migration 0033 repairs development databases that recorded earlier versions of 0031/0032 without
the timeline revision or preference error columns. It preserves cached vectors, seed membership,
timeline contents and cursors; startup resets only optimistic revision counters and transient
preference preparation errors.
Migration progress matches stored markers to the current journal, so extra historical markers
cannot cause a pending repair to be skipped.
Quantity defaults to 20 and accepts 1–500. Settings and source edits apply only to future decisions.
The editor retains raw exclusion text in the parent draft immediately, including unfinished comma
separators, while parsing concepts for debounced previews and save payloads. Text edits wait 750 ms;
other controls wait 250 ms without shortening a pending text delay. Superseded preview HTTP requests
are aborted and stale results ignored. Embedding events coalesce into serial, quiet sample refreshes
at most once per second; overview events also coalesce. Already queued inference may finish and cache
its result. Semantic selection
honors primary first-item fitting and longest-fitting filler, retaining seed order for duration ties.

Each persistent scheduling consumer owns immutable, ordered seed generations in SQLite, including
across occurrence resets. Consumption advances only with committed timeline segments; previews and
rejected scheduling branches cannot consume entries. Seed decisions, timeline rows, and cursor deltas
commit atomically with a timeline revision check and unique generation/ordinal constraints. Rewinds
reuse persisted decisions. Retention preserves generations referenced by baseline or segment cursors
and later decisions. Committed entries resolve catalog compatibility aliases for playback while
recording consumption against the original seed IDs, so multipart reconciliation can complete an
existing set without rewriting its membership. Missing items remain unconsumed and produce
diagnostics instead of silently
changing a seed. The editor exposes preparation state and remaining schedule selections per consumer. Read-only draft
previews and overview carousels share bounded, cached semantic samples without writing seed state.
The API reports full related-pool and requested counts separately from the carousel limit; shortages
are shown only once preparation has settled. Catalog loading follows reachable sequence/similarity
references, reads vectors only from source libraries and retained seeds only for reachable Programs,
and caches refinement snapshots until catalog invalidation. Content-only scopes do no semantic reads. Worker cache identities include the reachable semantic
Program/library scope, so identical media pools cannot reuse another Program's seed history.
Nested consumers include the child Program identity. Deleted Program checkpoints remain replayable
without recreating owned seed rows. Deleting a channel schedule atomically removes that channel's
semantic seeds and membership alongside its timeline and cursors, then invalidates cached catalogs;
reassignment generates fresh decisions from current settings without affecting other channels.
Semantic recovery fingerprints track relevant availability while
excluding embedding changes unrelated to a channel's sources.

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

The Programs catalog is searchable and filterable by content, sequence, similarity, or theme type. It sorts names
alphabetically using media title normalization, ignoring punctuation and leading A, An, or The.
Content rows expose
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

The Templates catalog sorts names alphabetically using the same media title normalization as
Programs, ignoring punctuation and leading A, An, or The.

A template describes one nominal local day. Slots allocate time to programs, while explicit
boundaries describe how adjacent slots resolve against real media durations.
New editor templates share Quick Setup's allow-overrun item starts and finish-left boundaries with
unlimited drift. Added slots retain their source slot's settings and default new boundaries to
finish-left with unlimited drift. Geometry edits preserve explicit unlimited drift. Stored templates
and omitted-field API parsing retain their existing behavior.

A channel has an always-available base template. Conditional templates stack above it and can use
nested date, month, weekday, annual-range, and time-range predicates. A no-program slot is transparent:
it falls through to the next lower layer. Its slot filler is therefore disabled.
New schedule drafts suggest a base template by channel name: normalized exact matches precede full
channel-name phrases, then relative edit distance; ties retain catalog order. The suggestion does
not replace saved base templates or change how conditional layers are initialized.

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

Saved channel schedules become durable rolling timelines in SQLite. The advertised XMLTV and playout
window is 14 local days. The stored window keeps one extra local day so that window still covers the
advertised 14 days after local midnight, before the next materialization pass replenishes the
lookahead day. Each commit atomically
stores:

- concrete timestamped segments;
- bounded media metadata snapshots;
- per-segment selection-state transitions;
- the continuation cursor at the end of the window.

Window rolls preserve overlapping advertised entries and generate only the uncovered tail. Occupancy
and existing-window reads omit media snapshots. Channel generation is pipelined across the scheduling
worker pool so one channel can generate while the previous channel commits, while occupancy from
earlier channels in the same pass still constrains later ones. A restart
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
Timeline segments and selection cursors are inserted in bounded batches within the same transaction,
so dense schedules do not exceed SQLite's per-statement parameter limit.
Large scheduling and reconciliation identifier sets use JSON membership queries to avoid per-ID
SQL parameters. Scan conflict and multipart-alias inserts use bounded batches while retaining
transactional rollback. Viewing-preference title lookups use the same membership-query approach.

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
M3U entries include Channels DVR's `channel-id` from the persistent channel UUID and
`channel-number` from the configured number, using the existing M3U escaping. The UUID remains
stable across renames and renumbering; existing `tvg-id`, `tvg-chno`, XMLTV identifiers, and stream
URL generation remain unchanged.
The Guide timeline fits approximately two elapsed hours on phones (up to 680px), four on tablets
(up to 1220px), and six on desktops; Channels retains its six-hour scale. The Guide week controls
and synchronized time ruler remain sticky during page scrolling, below the mobile app header. The Guide
page channel column uses fixed-width number, unbezeled icon, and name tracks. Guide listings may show
a landscape or poster thumbnail when width allows, using the card artwork variant so stills stay
sharp at listing height. Landscape thumbs are cropped to a square. Listings show vertically centered
title and timespan copy, a 24-hour timespan, and a dimmed fanart wash. Adjacent listings leave a small gutter.
Guide listings, schedule editors, and previews share 32 curated program gradients selected by a stable
program-ID hash. Opaque white text maintains at least 4.5:1 contrast across the gradients; the fanart
wash is darkened before compositing to preserve that contrast even with bright artwork. Thumbnails
retain their original brightness. Palette expansion can reassign program colors without changing
stored scheduling data.
Channels keeps the compact logo-above-number cell.
On Channels, the edit button covers the full channel cell while warning badges remain independently
interactive; keyboard focus outlines the complete edit target.
The shared guide expands to its full row height and scrolls vertically with the page, while
retaining horizontal timeline scrolling. Programme nodes are mounted only for the scrolled elapsed-time
window plus two hours of overscan, including the initial mount. Large lineups mount only nearby
channel and family rows, with measured heights and eight rows of vertical overscan on each side. Small embedded
previews retain all their rows. Focused rows remain mounted, and keyboard navigation reveals the next
channel when needed. Immutable guide snapshots use shallow reactivity; weakly owned per-channel
interval indexes reuse parsed timestamps across route remounts without retaining replaced snapshots.
Calendar geometry is independent of zoom, and listing presentation is derived only for mounted entries.
Guide and Channels request one committed day first, then the remainder of the seven-day window,
so the visible range paints before the rest of the week arrives. Concurrent route bootstrap reads share
an in-flight guide request; explicit refreshes and live changes can supersede it. Combined guide reads select
timeline-segment columns without snapshot, cursor, or playback JSON, omit duplicate `entries` when
the timeline is item-mode, use one time-ordered `starts_at`/`channel_id` limit query, and cache the
assembled guide in-process until timeline, channel, or scheduling events invalidate it.
On both pages, Today centers the now line in the visible timeline when the current guide window
is already selected, without reloading guide data.
Individual media entries share Programs' delayed, cached metadata preview on hover and keyboard
focus, using one preview instance per guide. Clicks retain segment details; guide blocks retain
their actual-items timeline preview. Gaps and entries without media do not request metadata previews.

Guide timeline and compact schedule-preview geometry use elapsed instants across each configured
local date. Daylight-saving transitions therefore render 23-hour and 25-hour days at their actual
width instead of assuming every local day lasts 24 hours.

### Slot guide presentation

Template slots optionally replace individual listings with an authored title and description.
Draft template and layered previews use the same guide projection and expose actual items within blocks.
Block hover and tap reveal a 30-minute timeline crop centered on pointer time, clamped to the block;
keyboard focus uses its midpoint. The floating preview centers on pointer or tap position within
viewport bounds and tracks glowing position and range-boundary markers. Hover previews omit the close button;
keyboard and click/tap presentations retain it. Preview responses include current source-program
names for guide labels; filler and gap labels remain role-based. Crops reuse Guide item styling and preserve actual item identities.
Their playback segments and diagnostics remain unchanged.
An empty title override uses the slot’s current program name, or “No programming” for an empty slot.
A shared presentation projection serves XMLTV and Guide-page entries while retaining original
playback segments and detail targets. Scheduled blocks use effective nominal intervals and take
precedence over intersecting listings; drift blocks follow realized start and finish, including
filler and dead air. Layer overrides split effective occurrences. Displaced scheduled blocks remain
visible; displaced drift blocks are omitted. Guide hover, focus, and tap expose actual intersecting
items with their original airtimes, mounting only items that intersect the magnified time window.

Occurrence metadata shares the committed timeline's atomic persistence and rolling retention.
Legacy windows recover associations without replaying selection; ambiguous or structurally pending
legacy occurrences retain individual listings until normal materialization provides metadata.
Guide-only saves invalidate guide output immediately while preserving scheduling fingerprints,
committed media, and selection state. Existing slots default to individual listings. Additive guide
entries preserve the existing schedule-guide segment contract; metadata is read in bounded batches.
DST-converted scheduled blocks are clipped at the next block’s start to prevent overlapping listings.
Projected entries retain the shared guide entry limit, shortening to complete local days when needed,
and occurrence recording is restricted to
the requested window, including early-started content crossing its final boundary.

### XMLTV

The XMLTV document comes only from the committed rolling timeline. It includes every configured
channel, explicit no-programming intervals, bounded metadata snapshots, episode data, and proxied
artwork where available. Each channel uses its assigned Liquid guide template, or the saved default
when none is assigned. Templates have a built-in read-only Standard XMLTV layout and per-type
sources for channel, episode, movie, music video, other, filler, no-programming, and block listings.
The built-in movie and episode layouts emit `Movie` and `Series` programme categories respectively,
alongside media genres, for client content-type classification. Saved custom sources remain authored;
blank tabs inherit the current built-in layout.
Published XMLTV is minified after a successful render. The Guide timeline uses the same per-channel
templates for listing titles and optional subtitles. The Channels timeline keeps program-source
labels. The template editor preview renders the unpublished draft. Invalid live sources fall back to
the built-in layout for that type.

Channel identifiers use this stable format:

```text
C<channel-number>.<short-channel-id>.moirai.tv
```

For example: `C601.1.a1b2c3d4.moirai.tv`.

Every XMLTV icon URL contains a source or channel version query parameter so clients can refresh
changed artwork without disabling caching. Conditional requests use ETags. Only committed timeline
or channel-presentation, guide-template, or default-template changes invalidate the cached XMLTV
document.

A scheduled channel must have a healthy, contiguous committed window before its guide and playback
are authoritative. Incomplete output returns a retryable unavailable response instead of pretending
the gap is intentional dead air.

### ErsatzTV-Next integration

Moirai owns channel configuration and maps it through a compatibility adapter pinned to ErsatzTV-Next
revision `11a9fe8f8f383eab2de83f2173019cde34726830`. The adapter retains only the channel and playout
schemas used by the integrated worker; vendored files retain upstream MIT attribution.
Generated playout uses schema `0.0.4`; the worker also accepts existing `0.0.3` documents.
Deploy the application and engine together. On rollback, stop workers and regenerate playout with
the restored application before tuning because the previous engine rejects `0.0.4`.

The worker probes HDR10 metadata from containers and, when needed, a bounded first-frame probe
(with a five-second timeout). Existing settings gain QSV HDR10 tone mapping, legacy Intel capability
detection, hardware padding/filter fusion, CUDA/libplacebo optimization, and AMF capability detection
and scaling where supported. Moirai continues to omit probe hints so worker probing remains active.

`MOIRAI_DEBUG` enables engine fallback error cards for all channels after a server restart. It defaults
to false, accepts trimmed case-insensitive `true`/`false` or `1`/`0`, treats empty values as false, and
rejects other values at startup. Explicit application configuration overrides the environment.
This flag is independent of `MOIRAI_LOG_LEVEL` and does not replace managed schedule fallback video.
Cards can expose file paths and FFmpeg details to viewers; ordinary operation keeps them disabled.

New channels default to Moirai's `Automatic` hardware-acceleration setting. Immediately before
playback, Moirai runs bounded one-frame FFmpeg encoder probes for the configured codec, bit depth,
and output dimensions, preferring discrete devices and then platform-integrated backends. The
verified result is converted to a concrete ErsatzTV-Next acceleration value; if no compatible
encoder is found, playback receives `None`. Channel and encoding-profile editor predictions use the same server-visible probe and
five-minute bounded cache. Read-only profile views also predict Automatic acceleration using the
server-default FFmpeg; channel predictions retain their channel-specific FFmpeg override. Automatic probes support 8-bit and 10-bit targets through 8K UHD, while
explicit backend selections remain available for other configurations. Existing channels that store
`None` are not migrated. Distinct probes share a bounded queue whose eight-second deadline includes
queue time. Indeterminate results and source-sized outputs are not cached, allowing playback to retry
before safely falling back to `None`. Recognized probe failures distinguish missing devices, denied
access, unavailable encoders, and unavailable drivers in the existing prediction detail field.
Explicit VAAPI paths receive a read/write access check; bounded stderr is classified but never
returned verbatim. Unrecognized failures remain inconclusive. Encoding editors expose these
details with installation guidance for DRM group/device mappings and NVIDIA Container Toolkit.

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
and that stream must have a measured duration of at least 30 seconds; a longer audio or container
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
uses its captured artwork reference. Now-playing titles include series and episode coordinates for
shows and artist credits for music videos. New media snapshots retain artist credits; older music
snapshots fall back to a catalog join within the same query, without rewriting committed timelines.
Missing metadata is omitted, and movie titles retain their existing presentation.
The Status page shows that poster, advances the item's position
locally, refreshes at its finish boundary, follows playback events, and periodically reads the
non-cacheable status resource so session starts and stops recover even when a live event connection
is interrupted.

When local viewing preferences are enabled, each approximate client and media encounter must remain
active for two minutes before it is recorded. The initial item in a tune session contributes two
points and later items contribute one. Only media and show references, encounter type, points, and
time are persisted; network addresses and User-Agents are not. Effective scores use a 180-day
half-life, and negligible events are pruned after two years. Administrators can inspect the strongest
decayed preferences from a Current scores dialog on Settings, with artwork, hierarchy labels, and
the catalog plot hover, disable both collection and application, or permanently clear the history
from a two-step control in that dialog. Preference changes affect only timeline days subsequently
appended to the committed 14-day window.

### Audio stream preferences

Channel and content/sequence program configuration can carry independent optional audio language
and title preferences. Absent fields inherit through captured program ancestry; null clears an
inherited preference. No preferences preserves worker defaults. Otherwise selection ranks matching
language aliases, case-insensitive title substrings, default disposition, descending channel count,
and stream index, retaining candidates when a preference has no matches. Indexed technical metadata
is fetched in bounded batches only for relevant media; multipart files select independently.
The playout adapter supplies `tracks.audio.stream_index` alongside existing subtitle selections,
without changing the worker or overriding generated silence. Missing metadata falls back to worker
selection. Channel fallback override files retain their existing behavior. Selection cursor identity
excludes audio preferences, and changes flow through normal playout reconciliation without restarting
the active item. Probe cache version 4 collects channel counts on the next normal scan; old metadata
remains usable with unknown counts ranked below known counts. No automatic rescan or database
migration is required.

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

Publishing a GitHub release triggers `.github/workflows/publish-image.yml` to build that tagged
commit for `linux/amd64` and push to `ghcr.io/<owner>/<repository>` using the workflow's scoped
`GITHUB_TOKEN`. Images receive the release tag and its normalized semantic version; stable releases
also update `latest`. Prereleases and tags containing a hyphen leave `latest` unchanged. The Docker
build enforces the production guide review gate. Full application verification and screenshot
refresh remain required release preparation steps documented in `CONTRIBUTING.md`.

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

The HTTP listener binds before SQLite migrations run. A public bootstrap page reports migration
progress while a worker applies pending Drizzle files so the Node event loop can still answer health
probes. `/api/v1/health/ready` returns 200 during that window with a non-essential `migration` check
so Docker health does not unroute the container. After migrations finish, the full application
replaces the bootstrap listener.

Health endpoints have separate meanings:

- `/api/v1/health` and `/api/v1/health/live` are dependency-free liveness checks.
- `/api/v1/health/startup` reports public migration progress (`migrating`, `ready`, or `failed`).
- `/api/v1/health/ready` checks SQLite and the playback engine as essential, and reports scanner,
  media probe, maintenance, timeline, playout sync, media sources, and resource pressure as
  non-blocking context.
- Readiness returns `503` only when SQLite or the playback engine cannot serve. Background and
  per-channel schedule problems stay in the JSON as degraded, non-essential checks.

Readiness timeline status selects only window and health columns. Long catalog, guide, and
materialization work yields to the event loop so the 3-second Docker probe can run.

Docker uses readiness for its container health check.

### SPA architecture

Vue 3, Vite, Vue Router, and Pinia provide the management SPA. Major views include:

- library configuration, browsing, health, and reconciliation;
- media details and best-effort in-browser file preview; credits distinguish explicit non-acting
  appearances and production jobs from Stars, preserving unknown or mixed acting roles as cast, with
  independently remembered More disclosures;
- channel normalization and artwork;
- a Playback group for reusable encoding profiles, XMLTV guide templates, and music video credit templates;
- guided Quick Setup for movie, show, and music video channels;
- reusable Programs and daily Templates;
- layered Channel Schedules;
- channel and dedicated EPG guide views;
- administrator account and local fallback credential management;
- playback, status, and log views.

The primary Status navigation item also carries the live IPTV readiness state and active channel
count without a separate sidebar card. Navigation scrolls within the available viewport while the
account and sign-out controls remain accessible in the sidebar footer. Unmatched management paths
render an in-app missing-page view inside the shell. Uncaught Vue render failures use the same
empty-state pattern, with reload and Status actions, without putting the error in the URL.

Status conflicts link directly to the affected program or template, with catalog destinations when
no resource ID is available. Account credential updates use the shared dismissible success toast;
credential errors remain beside the form.

Modal editors, Help, confirmations, and mobile navigation share a focus-trap stack. Only the
active layer owns keyboard focus; surrounding content is inert, and dismissal restores the opener
or a surviving destination. Closed mobile navigation is inert below the existing breakpoint.
Editor guide popovers render in their owning backdrop to remain within its focus boundary while
avoiding clipping by scrolling editor content; standalone guide popovers render at the page root.

Saveable resource drafts register native unload protection only while dirty. Library creation and
Settings also confirm route departure without implicitly saving independent sections. Explicit
sign-out checks active drafts before revoking authentication. Cancelled unloads preserve live events.

Settings loads configuration, engine status, learned history, and fallback metadata independently.
Failures retain contextual retry actions; status polling cannot clear unrelated load or save errors,
and retries preserve drafts belonging to other panels. Unavailable configuration and engine state
are not presented as loaded defaults or zero activity. Account, capacity, and shared encoding fields
reveal schema-based errors after blur and update them during correction. Encoding editors summarize
touched errors beside Save, including when channel encoding controls are collapsed; replacing a draft
clears its interaction history without changing the underlying validation contracts.
New channel forms start video/audio and additional subtitle disclosures closed, independently of
remembered disclosure preferences for existing channels.

### Resource navigation and direct usage

Resource catalogs use the same destination vocabulary as navigation. Library creation shares fields
and the modal lifecycle with library settings, retaining Add and Scan and existing draft protection.
Program, template, and channel-schedule introductions live in their corresponding guide topics.
Restricted Markdown callouts preserve their icon and card presentation in both the guide and Help
drawer. Internal management links use ordinary guarded routes.

Saved programs, templates, encoding profiles, credit templates, and guide templates expose Used by in the editor
title bar, left of the close control, with a GitBranch icon and a live reference count. Expanding
it opens a right-side panel that narrows the editor content and can be closed from the panel or
the title-bar control. On narrow screens the open panel replaces the form visually without
unmounting its draft. The closed title-bar control does not displace the form. The sidebar animates
a contained grid-width transition so controls reflow without scaling; reduced motion skips the
animation. Continuous resizing is an intentional UX tradeoff to avoid an abrupt width change. The
authenticated resource-usage endpoint groups direct authored occurrences by owner, with role labels
and bounded pagination (50 resources by default, at most 100). Guide-template usage includes channels
that inherit the current default because they have no assignment. Encoding-profile usage remains the
saved profile id; Custom channels are independent of the encoding default. For reusable resources, three scoped
queries check existence, count owners, and retrieve a page in one read transaction; neither catalog
requests nor playback acquire additional queries. Media detail pages keep a right-edge Used by tab
with the TV icon for direct item selections, ancestor-group membership, and current library-query
matches. Query matching shares the scheduling catalog, filters, ordering, and
item limits; one library catalog serves all relevant queries without per-program database reads.
Membership includes unavailable items and does not guarantee playback. Adding an item to a program
refreshes an open disclosure. A separately paginated Playing at section reads current and upcoming
committed timeline occurrences with channel names and times, including absorbed item aliases. It
never materializes schedules or advances selection state; empty results describe only committed
showings. The media-only TV disclosure is anchored to the app content edge.
Usage does not expand inheritance or downstream channels and does not replace authoritative deletion
checks. Channel references open `/channels?edit=<id>`; missing channels are reported and route
changes preserve dirty-editor guards.

Route state preserves sorting, filters, hierarchy, pagination, and within-page catalog anchors so
browser back and forward navigation restore the same view. Loaded stores retain prior data when a user
returns to a page; initial empty collections have explicit loading states. Library navigation shows
compact scan-status icons derived from shared library metadata and updated directly by scan events,
without fetching a separate scan history for each library or refreshing on every progress event.

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

Resource editor titles expose help with explicit topic IDs, including nested editors whose route
belongs to another resource. Help immediately receives focus and makes the underlying editor inert;
Tab stays inside the drawer and Escape dismisses only help. Closing help restores its opener without
navigating, saving, or discarding the editor draft.

Each authored page is hashed from normalized Markdown and every referenced local screenshot. A
versioned registry records explicitly approved digests and timestamps; prose, link, or screenshot
changes therefore return the page to `needs-review`. Drafts remain visible in normal builds with a
warning, while `build:production` and Docker builds reject any outstanding review. The generated
`/help/review.html` dashboard and `docs:user:review:list` command expose the review queue. Guide
sidebar links show review badges from the same generated manifest, refreshed when the guide builds. The
guide outlines added or changed Markdown blocks and changed images using verified approval diffs.
Initial pages are outlined throughout; unavailable baselines do not produce guessed text highlights.
Removed content remains available in the comparison dashboard. The
dashboard includes in-place Before/After image comparisons, initially showing After, and unified
Markdown text diffs. Build-time Git history lookup verifies each baseline against its approval digest
within the last 100 guide commits; unavailable history is labeled explicitly. Generated comparison
images use content-addressed URLs and are cleared on regeneration. Viewing comparisons never changes
approvals, and builds from source archives remain supported without Git history.

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
channel using the saved default encoding profile, and its base assignment. Program and generated
template names keep the requested base when free and otherwise take the next unused numeric suffix,
matching the case-insensitive uniqueness keys; a taken channel number still fails the transaction. A new library remains
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
