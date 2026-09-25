---
id: scheduling.programs
title: Programs
description: Choose media and control the order in which a schedule uses it.
contextual: true
---

# ![](/icons/list-video.svg) Programs

> [!INTRODUCTION]
>
> ## ![](/icons/introduction-program.svg) What is a program?
>
> A program is a reusable rule that tells Moirai what content to play and in what order. Use programs in your schedule slots to build your channel lineup.
>
> ### Common program types
>
> - ![](/icons/introduction-shuffle.svg)
>
>   **Shuffle Movies**
>
>   Random movies with no repeats until all play
>
> - ![](/icons/introduction-ordered.svg)
>
>   **Sequential Shows**
>
>   Play episodes in order, continuing where you left off
>
> - ![](/icons/introduction-sequence.svg)
>
>   **Mixed Sequence**
>
>   Combine shows, movies, and more in a custom order
>
> - ![](/icons/introduction-random.svg)
>
>   **Random Anything**
>
>   Random from any collection or library query

In a saved program, open **Used by** in the editor title bar to see direct sequence, template, and schedule references.

A ![](/icons/list-video.svg) Program is a reusable rule that tells Moirai what content to play and in what order. ![](/icons/calendar-range.svg) Templates use ![](/icons/list-video.svg) Programs in their time slots, so one ![](/icons/list-video.svg) Program can appear on several ![](/icons/tv-minimal.svg) Channels or days.

The Programs list starts in alphabetical order, ignoring punctuation and leading “A”, “An”, or “The”, just like media titles. Search by name or definition, filter by Program type, Content definition, or usage, and choose a different sort order.

Select a Program to inspect its definition, media sample, health, and direct references. Close the drawer with its close button or Escape. Choose **Edit Program** to make any changes.

The **Items** column shows the indexed count; its tooltip reports unavailable items when any exist. The **Used by** count includes authored uses in Programs, templates, and channel schedules; it is not solely a count of Channels it appears on. **Used by** lists the direct resources. Similar Items and Theme previews show sample matches, while **Current sets** reports the remaining items in each schedule use.

![The programs catalog](/screenshots/programs.png)

## Content Programs

Choose **Content** when the ![](/icons/list-video.svg) Program should select media from a library. You can choose the media yourself or use a query that finds matching items as the library changes.

![Create a Content Program with a populated library query](/screenshots/program-content-create.png)

### Choose specific media

Use an explicit selection when you want to control which items are eligible. Review the selected media and arrange its order before choosing how playback moves through it. A hand-picked list of media is still a Content ![](/icons/list-video.svg) Program; a Sequence ![](/icons/list-video.svg) Program combines other ![](/icons/list-video.svg) Programs instead.

You can also select shows, seasons, artists, or albums directly in the library browser and choose **Add Selected**. Create a new program or add to a selected-groups program from the same library. For example, select seasons 1–8 of a show and use **Sequential** to play their episodes in order, excluding later seasons. Group selections include newly indexed content within those groups; individual-item selections retain specific items.

When browsing inside a show, season, artist, or album in the media picker, use **← Back to Library Root** to return to the top of that library.

### Use a library query

Library queries share the catalog filters: title, release year, indexed date, rating, actors, directors, and primary, included, or excluded genres. Music-video queries also support Artist and Album. Choose **Configure Filters** to refine the matches. Order the query by title/episode, indexed date, or release date, in either direction, and optionally limit the ordered set. The media carousel updates as scanning adds or changes matching items.

The item limit applies before unusable or unavailable media is excluded. If some of the limited items cannot play, Moirai does not replace them with matches outside that limit. Query ordering defines the candidate set; the selection strategy below controls playback through that set.

### Choose the playback order

The **Selection** controls determine how eligible items are consumed:

- **Sequential** follows the configured order.
- **Shuffle (no repeats)** uses a shuffled order without repeating an item until the pool has been played.
- **Random** chooses an item each time, so repeats are possible.
- **Weighted random** favors content your viewers have chosen while retaining variety.

The optional **Stable seed** makes randomized choices repeatable. Whether playback continues from its previous position or restarts each day is configured in the ![](/icons/calendar-range.svg) Template slot, under **Advanced scheduling behavior**.

## Similar Items Programs

Choose **Similar Items** to find media related to a hand-picked Content Program. First create a Content Program whose source is **Specific media items**, then select it as the **Source Program**. Library queries, selected groups, and Sequence Programs cannot be sources.

Open **Additional filters** below Source Program to restrict which related items can qualify. Use **Configure Filters** for the same genre, year, rating, and other metadata rules as filters elsewhere. Filters apply to candidate matches only; source items still guide similarity even when they do not meet those filters.

![Create a Similar Items Program](/screenshots/program-similarity-create.png)

Move the **Cohesion / Variety** slider toward Cohesive for closer matches, or toward Varied for a more diverse selection that still relates to the source. **Quantity** sets the number of items in each set, from 1 to 500, with 20 as the default. Recommendations stay within the source library and media kinds, and they exclude the source items. Episode selections recommend episodes; music selections use title, artist, album, and available descriptive information.

Below Quantity, use either or both optional refinements:

- **Preferences:** describe themes to favor, such as “darker, slower-paced science fiction.” This is a preference, not a guarantee.
- **Exclusions:** enter comma-separated concepts to avoid, such as `superhero movies, romantic comedies`. Describe the concept itself rather than writing “no superhero movies.” Increase **Exclusion strictness** to exclude broader matches, or lower it to exclude only closer matches. This is approximate, so check **Excluded matches** alongside the remaining sample and adjust as needed.

**Excluded matches** shows a sample of available candidates filtered out by your concepts and strictness. While Moirai prepares matches, the preview shows a loading message over dimmed cards. Changes do not affect existing active sets still finish unchanged and apply at the next schedule generation.

**Sample matches** in the editor update as you change the source, library filters, variety, quantity, or refinements. When there are fewer related matches than your requested Quantity, both previews show the available count and requested count. This count covers all related matches, not just the cards visible in the preview. These previews may differ from the set selected for a schedule.

New refinements are prepared between small batches of library items if it is actively scanning, so they can become ready while library preparation is still running.

Each schedule use keeps its own set. The set and its order survive restarts, new library items, and edits. Changing source contents, library filters, variety, quantity, or refinements affects the next set. The current set finishes first, even for slots configured to restart daily. New sets prefer items absent from the last ten completed sets. When reuse is needed, items from the least recent set are preferred. Smaller libraries may reuse media or produce fewer matches.

Items count as used when Moirai commits them to its schedule, so the displayed remaining count describes schedule preparation rather than what viewers have already watched. A temporarily unavailable or deleted remaining item keeps its place and prevents that set from finishing until the item is available again. Moirai shows a warning instead of silently replacing it.

Removing a channel's schedule clears its Similar Items sets and selection history. Assigning a schedule again starts fresh sets using the current Program settings; other channels keep their sets.

Similarity runs locally on the server. Initial library preparation happens in the background; the Program shows preparation or failure status while waiting for usable matches. If Moirai cannot finish preparing matches, open the Program editor and choose **Retry preparation**. This retries only the failed preparation for relevant media and your current theme, preferences, and exclusions. Items already prepared and active sets stay unchanged. Both container and native builds bundle the model, so installing or running the built application needs no model download or outbound connection. See [configuration](/operations/configuration) for packaging details.

## Theme Programs

Choose **Theme** to find media matching a description. Select a **Target library**, use **Configure Filters** to choose which media can qualify, then enter a **Theme**, such as “space exploration and first contact” or “quiet mysteries in small towns.” Matches use the media’s titles, descriptions, and other metadata.

Filters use the same rules as filters elsewhere and are applied before theme matching. For example, require the Comedy genre and enter “raunchy late-night comedies” to rank only comedies by that theme. Leave the filters empty to consider all compatible media.

![Create a Theme Program](/screenshots/program-theme-create.png)

Use **Quantity**, **Cohesion / Variety**, **Preferences**, and **Exclusions** just as you would for Similar Items. Review **Sample matches** and **Excluded matches** as you refine the theme.

Each schedule use keeps its own set and finishes it before selecting another. Changes to the theme, target library, library filters, quantity, or refinements apply to the next set. The same preparation status, retry controls, and rotation behavior described below apply to Theme Programs. If a scan corrects a media runtime, the schedule refreshes its future timings at the next daily boundary.

## Sequence Programs

Choose **Sequence** when you want to combine existing ![](/icons/list-video.svg) Programs in a custom order. For example, you could play two items from an episode-selection ![](/icons/list-video.svg) Program, then one item from a movie-selection ![](/icons/list-video.svg) Program.

![Create a Sequence Program with three counted steps referencing different Programs](/screenshots/program-sequence-create.png)

1. Create the ![](/icons/list-video.svg) Programs you want to combine first.
2. In the Sequence editor, choose **Add Step** and select a ![](/icons/list-video.svg) Program.
3. Set the count for that step and add any remaining steps.
4. Use the up and down arrows to arrange the steps.
5. Choose **Ordering**: **Ordered** keeps the listed step order; **Shuffled blocks** shuffles steps while keeping their selections together; **Shuffled allocations** mixes selections while keeping each step’s count; **Balanced rotation** spreads selections proportionally and avoids consecutive turns from the same step when possible. Shuffle modes offer an optional **Stable seed**.
6. Enable **Repeat sequence** to begin another cycle after its allocations finish, otherwise it plays only the sequence and leaves any remaining time empty.

When used as filler, **Shuffled blocks** keeps the current step together even when its next selection cannot fit. **Best fit only** leaves the remaining gap; **Best fit or truncate** can shorten the next selection from that step.

The inspector’s **Sequence Configuration** shows each source as a numbered block with a media preview and its configured count: **1 Item**, **2 Items**, and so on. A small **more** tile appears after the thumbnails when the source contains additional items beyond those shown. Select a block to inspect that source Program. The **items per cycle** total adds the configured step counts, including unavailable sources; it does not promise that every item is currently playable.

![Sequence Configuration with numbered source previews and selections per cycle](/screenshots/program-sequence-inspector.png)

The Programs list and inspector’s source preview show distinct media from the Sequence’s sources; they do not predict playback order or step counts.

### Preview a Sequence’s day

The Sequence editor and inspector include a **Guide preview** of one sample day, starting with fresh sequence and child progress. Four hours are visible at a time; scroll horizontally to explore the rest of the day. Each selection shows its title and times. Colors and the numbered legend identify the top-level step for easier verification.

![Sequence guide preview with a four-hour view, colored selections, and numbered entry legend](/screenshots/program-sequence-guide.png)

The sample updates automatically when you change steps, counts, repeat, ordering, or an active shuffle seed. Use **Refresh** to manually reload the sample.

This preview does not advance any Channel’s playback progress or predict an existing Channel’s current lineup. A Sequence with **Repeat sequence** disabled leaves a gap after it finishes. Unavailable sources and other scheduling issues appear below the preview.

Each referenced ![](/icons/list-video.svg) Program keeps its own media-selection rules. The Sequence controls how it takes selections from the steps and their counts; it does not assign clock times. The ![](/icons/calendar-range.svg) Template it's placed in decides when it runs.

For complete setup recipes, see [Example schedules](/scheduling/example-schedules). Counts are per cycle, not per day.

## Preview, save, and delete

The editor preview is safe to explore. Save only when the draft is valid and matches the intended audience. Deleting a program is permanent and can make template slots invalid, so inspect its usage before confirming deletion.

Leaving an edited program, including through **Manage credit templates**, asks whether to save or discard your changes. Choose **Cancel** to keep editing. If saving fails, the draft stays open so you can retry.

## Audio and subtitles

Programs can have their own audio and subtitle preferences, independently of the Channel they appear on. Set an override to use the Program's preference wherever it plays, or leave a field set to inherit so it follows the enclosing Sequence Program or Channel.

![Expanded Program audio and subtitle settings showing inherited preferences and music video credits](/screenshots/program-subtitles.png)

Open the optional **Audio and subtitles** section below the main configuration steps.

### Audio selection

Use **Preferred language code** (such as `en` or `eng`) and **Preferred audio title** to override the [Channel's audio preferences](/scheduling/channels). A title matches part of an audio track's name, ignoring case; it is not a regular expression.

Each field inherits independently from the Channel through enclosing Sequence Programs to the Content Program. Leave a field blank to inherit, or enter `*` to remove the inherited preference for that field. For example, a Sequence can prefer French while a Content Program clears the inherited title preference and keeps French.

Selection prefers matching language, then matching title, then default-flagged tracks, more audio channels, and the lowest stream index. A missing match falls back to other available audio; it does not silence the video. With both effective preferences cleared, the playback engine selects audio normally.

Scheduled filler follows its own captured program ancestry, and multipart videos select each physical file separately. Saving preferences preserves program selection progress and does not restart the current item.

### Subtitles and music video credits

The subtitle controls follow Audio selection in the same optional section.

Subtitles and music video credits serve different purposes. Ordinary subtitles come from embedded tracks or sidecar files discovered during library scanning; see [subtitle sidecar naming](/libraries/media-file-naming) if matching files are not appearing in the media details. Music video credits use catalog metadata, such as the artist and song title, to generate a credit overlay. The chosen template controls its appearance and timing.

### Inherit or override

Programs start with subtitle selection, language, and music video credits set to **Inherit**. Each field inherits independently from the containing Sequence Program, or from the [Channel](/scheduling/channels) when no containing Program supplies a value. A more-specific Program overrides its containing sequence.

For example, a Channel can prefer English subtitles, a Sequence can enable music video credits, and a Content Program within it can turn credits Off while retaining the inherited subtitle policy and language. A reusable Program with inherited settings can therefore behave differently on different Channels.

Changing only subtitle or credit preferences preserves playback progress, including a sequence's current position and completion state.

### Subtitle selection

Choose how Moirai selects an ordinary subtitle track for each video:

- **Inherit:** use the selection policy from the containing Program or Channel.
- **Off:** disable ordinary subtitles for this Program even if they are enabled in the inherited settings. Music video credits can still be enabled separately.
- **Forced only:** select a matching track marked **forced**. These tracks commonly translate foreign-language dialogue or signs rather than every spoken line. The track must carry the forced flag; Moirai does not infer it from the dialogue. If no matching forced track exists, the video plays without ordinary subtitles.
- **Prefer default:** prefer a matching track marked **default**. If none is marked default, select another matching track. Use this when your files already identify the subtitle track you normally want.
- **Any matching track:** select an available track that matches the language setting, without preferring default or forced flags. This selects one track; it does not send every available language to the viewer.

If several tracks qualify, Moirai prefers a track associated with the current physical part of a multipart video, then an embedded track over a sidecar. Prefer default checks the default flag before these tie-breakers. Selection is consistent between runs; it does not combine tracks or offer a track picker here. Hearing-impaired and commentary flags are recorded during scanning but are not separate selection filters.

### Preferred language code

Leave this field blank to **inherit** the language setting. Enter `*` to explicitly allow any language, including tracks with no language tag. Unlike a blank language field on a Channel, a blank field on a Program does not clear an inherited language restriction.

To select a specific language, enter a two- or three-letter code, such as `en` or `eng` for English, or `fr` or `fra` for French. Equivalent codes match the same language. The language setting is independent of the selection policy, so **Any matching track** still respects an inherited or explicit language restriction.

A specified language is a strict filter. For example, **Forced only** with `en` selects an English forced track; an English non-forced track or a French forced track does not qualify. If no track matches, Moirai omits ordinary subtitles instead of falling back to another language. Tracks with an unknown language do not satisfy an explicit language choice.

### Music video credits

- **Inherit:** use the credit-template setting from the containing Program or Channel.
- **Off:** disable credits for this Program even if inherited settings enable them. Ordinary subtitles can still appear according to the selection policy and language.
- **A named template:** use that [credit template](/playback/credit-templates) for music videos selected by this Program. Use **Manage credit templates** to view, duplicate, or customize a template; leaving an edited Program asks whether to save or discard its draft.

Credits replace ordinary subtitles on music videos; they are not added on top of lyrics or another subtitle track. Other media continues to use ordinary subtitle selection. Credits work even when **Subtitle selection** is Off, and the preferred subtitle language does not filter generated credits.

### Presentation follows the Channel

**Subtitle mode** and **Subtitle fonts folder** are configured in the [Channel editor](/scheduling/channels), not on individual Programs. **Burn** renders subtitles into the picture, so viewers cannot switch them off. **Convert** provides selected text subtitles as a selectable WebVTT track for compatible players; image-based subtitles such as PGS or VobSub are still burned. The Channel's optional fonts folder supplements installed system fonts for subtitles in ASS format, including generated credits.

Music video credits enabled on a Program in the prepared schedule automatically force **Burn** for the whole Channel, including ordinary subtitles on other videos. The Channel's saved Convert preference is retained and restored when credits are no longer enabled in that schedule. Turning credits Off on one Program does not restore Convert if other effective settings still enable credits. A running stream restarts when the effective mode changes, so enabling or disabling credits can briefly interrupt viewing.

### Check the result

Save the Program and test a scheduled video with a known matching subtitle track. Check the Channel editor for preparation issues if subtitles or credits are missing. Missing tracks, unreadable sidecars, and credit-preparation failures are omitted so Moirai can publish the video without them; a busy credit renderer retries during a later update. A subtitle that passes preparation can still encounter a decoding or rendering failure in the playback engine, so verify the result with your actual files and IPTV client.
