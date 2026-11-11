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

Use an explicit selection when you want to control which items are eligible. Choose **Sequential** to use an automatic **Playback order**, or choose **Manual** to rearrange items yourself. A hand-picked list of media is still a Content ![](/icons/list-video.svg) Program; a Sequence ![](/icons/list-video.svg) Program combines other ![](/icons/list-video.svg) Programs instead.

You can also select shows, seasons, artists, or albums directly in the library browser and choose **Add Selected**. Create a new program or add to a selected-groups program from the same library. For example, select seasons 1–8 of a show and use **Sequential** to play their episodes in order, excluding later seasons. Group selections include newly indexed content within those groups; individual-item selections retain specific items.

When browsing inside a show, season, artist, or album in the media picker, use **← Back to Library Root** to return to the top of that library.

### Use a library query

Library queries share the catalog filters: title, release year, indexed date, rating, actors, directors, and primary, included, or excluded genres. Music-video queries also support Artist and Album. Choose **Configure Filters** to refine the matches. Order the query by title/episode, indexed date, or release date, in either direction, and optionally limit the ordered set. The media carousel updates as scanning adds or changes matching items.

Moirai applies your exclusions before the item limit. For example, if a query is limited to 10 and you exclude two of the first 10 matches, the next two matches can fill those spots. The limit still applies before playback checks, so unavailable items within that limit do not get replaced. Query ordering defines the candidate set, and the selection strategy below controls playback through that set.

### Exclude specific media

Choose **Manage exclusions** to browse or search the Program’s library. Choose **Browse** next to a show or artist to find its seasons or albums. Choose **Exclude** and confirm for any item or group you want to skip. A group exclusion covers all its media, including media indexed later.

Hover over an indexed media item to preview its details, or tap its preview button on a touch screen. For lists with multiple pages, use **Previous** and **Next** in the bottom bar.

Open **Excluded** to review your entries. Choose **Restore** and confirm to remove an entry from the exclusion list. An excluded parent group still covers its items and subgroups after you restore an individual entry.

Choose **Done** to return to the editor. **Matching now** shows the remaining matches for a library query. Your original item or group selections and manual order stay editable. **Add** or **Save** applies the exclusions to your Program.

### Generate an AI selection

When a provider is enabled in [AI Settings](/operations/configuration), **AI** appears as a content source. Choose a library, describe the programs you want, then set **Results** from Few (about 50) through Most (about 250) and choose **Generate**. This is a loose target: different providers and models may actually return anywhere from few matches to many, including a modest overage for you to review before saving. They vary both in speed and in how broadly they interpret a prompt.

Moirai combines local title, genre, and plot matching with model knowledge and optional web research to review a broad shortlist. Without web search, it reviews up to 1,000 candidates in small batches and may make a final refinement pass. With web search, it considers up to 1,000 movie/other-media candidates or 1,500 episode candidates and may stop when the requested count or request-size limit is reached. Saving freezes the result, and later scans do not change it. Choose **Generate** again when you want a new list.

Each generation will cost API quota, including work performed before a failure or cancellation. While generating, the activity appears above the estimated percentage and elapsed time. The percentage follows preparation, review batches, and final refinement rather than elapsed time. After finishing, the selected count appears beside Generate with coverage such as **36 selected · 1,000 of 3,000 reviewed**. Warnings can identify any failures or limitations.

Choose **Review results** to browse or search the eligible results, including those from a saved AI Program. Choose **Exclude** and confirm to hide an item from **Results** while keeping it in the frozen selection. Future generations skip excluded items and items in excluded groups. To undo an exclusion, open **Excluded**, choose **Restore**, and confirm. If the item is still in the frozen selection and no other exclusion covers it, it returns to **Results** immediately. An item skipped during generation or removed from an older AI selection becomes eligible for a future generation.

AI drafts, including the name, prompt, requested result count, selection, exclusions, and playback preferences, are saved automatically in your current browser. Close the editor or reload the page, then reopen the same Program (or New Program) to continue. Generation keeps running while the page is closed; reopening reconnects without starting another paid request. Save is unavailable until generation finishes. Browser drafts do not sync between devices. If browser storage is unavailable, keep the page open and use Save.

Describe any requirements and exclusions explicitly, using words such as “only” or “must” for essential features. “Prefer” and “avoid” guide the choices without excluding every title whose details are unknown. A prompt can ask for a dominant theme with a few related picks. The model is asked to separate direct matches from supporting picks and avoid filling a quota, but some models select more loosely than others. Specify a year range when terms such as “modern” would be ambiguous. Selection uses the compact library list, available catalog ratings, and the model's knowledge of each work; a catalog rating may not reflect fan consensus, and the model can still make mistakes.

When [web search is enabled](/operations/configuration), discovery and the first library review use the model's knowledge without searching. A final search verifies uncertain titles with a requested budget of sixteen search-tool uses and a three-minute generation target. Providers may count and bill searches differently. Episode research checks the specific episode rather than assuming the whole series qualifies. Uncertain candidates are omitted when evidence or budget is insufficient. Search adds time and may incur provider charges. Without search, the model uses the library metadata and its own knowledge, which may not necessarily be detailed enough for all prompts.

Saving and playback do not perform lookups. With no web search, failed model planning can continue with local prompt matching. A failed review batch may leave a smaller selection from completed batches, and an unsuccessful final refinement may leave their validated picks. Persistent warnings identify these cases and the reviewed count shows how far Moirai got. A manual cancellation or generation with no valid review batch preserves your previous selection.

### Choose the playback order

The **Selection** controls determine how eligible items are consumed:

- **Sequential** follows the configured playback order, continuing from its position according to its playback progress settings.
- **Shuffle (no repeats)** uses a shuffled order without repeating an item until the pool has been played.
- **Random** chooses an item each time, so repeats are possible.
- **Weighted random** favors content your viewers have chosen while retaining variety.

For a new **Specific media items** program in a show library, **Season / episode** is the default: shows stay together alphabetically, and episodes play in numeric season and episode order within each show. **Last to first** reverses the episode order within each show. Specials in season zero come before season one in **First to last** order; missing show or episode information comes last. Existing programs keep their saved order.

![Sequential playback order for selected episodes](/screenshots/program-playback-order.png)

**Date Added to Program** follows the order in which items were added within Moirai. **Name** and **Release Date** offer other automatic orders. **Manual** captures the current displayed order so you can rearrange it. The numbered list shows the configured order.

Programs that select whole shows or seasons use their built-in season and episode order. Library queries follow their source’s query order, and AI selections follow their source’s Order and Direction controls; AI selections in show libraries also offer **Season / episode**.

The optional **Stable seed** makes randomized choices repeatable. When assigned directly to a channel, a program continues from its saved position automatically. In a ![](/icons/calendar-range.svg) Template slot, choose **Continue from saved position** or **Restart each day** under **Advanced scheduling behavior → Playback progress**. Continuing progress carries both a sequence and its child programs forward; it does not restart each block at its first episode.

## Similar Items Programs

Choose **Similar Items** to find media related to a Content Program with **Specific media items** or a saved **AI** selection, then select it as the **Source Program**. The selected items guide similarity; changing that selection affects future sets after the current set finishes. Library queries, selected groups, and Sequence Programs cannot be sources.

Open **Additional filters** below Source Program to restrict which related items can qualify. Use **Configure Filters** for the same genre, year, rating, and other metadata rules as filters elsewhere. Filters apply to candidate matches only; source items still guide similarity even when they do not meet those filters.

![Create a Similar Items Program](/screenshots/program-similarity-create.png)

Move the **Cohesion / Variety** slider toward Cohesive for closer matches, or toward Varied for a more diverse selection that still relates to the source. **Quantity** sets the number of items in each set, from 1 to 500, with 20 as the default. Recommendations stay within the source library and media kinds, and they exclude the source items. Episode selections recommend episodes; music selections use title, artist, album, and available descriptive information.

Below Quantity, use either or both optional refinements:

- **Preferences:** describe themes to favor, such as “darker, slower-paced science fiction.” This is a preference, not a guarantee.
- **Exclusions:** enter comma-separated concepts to avoid, such as `superhero movies, romantic comedies`. Describe the concept itself rather than writing “no superhero movies.” Increase **Exclusion strictness** to exclude broader matches, or lower it to exclude only closer matches. This is approximate, so check **Excluded matches** alongside the remaining sample and adjust as needed.

**Excluded matches** shows a sample of available candidates filtered out by your concepts and strictness. While Moirai prepares matches, the preview shows a loading message over dimmed cards. Changes to these exclusion concepts apply to the next set; existing active sets finish unchanged. Individually removed items are skipped as soon as you save the Program.

**Sample matches** in the editor update as you change the source, library filters, variety, quantity, or refinements. When there are fewer related matches than your requested Quantity, both previews show the available count and requested count. This count covers all related matches, not just the cards visible in the preview. These previews may differ from the set selected for a schedule.

New refinements are prepared between small batches of library items if it is actively scanning, so they can become ready while library preparation is still running.

Each schedule use keeps its own set. The set and its order survive restarts, new library items, and edits. Changing source contents, library filters, variety, quantity, or refinements affects the next set. The current set normally finishes first, even for slots configured to restart daily. With [simultaneous duplicate avoidance](/scheduling/channel-schedules#simultaneous-duplicates) enabled, primary programming can end a set early when every remaining item is playable but conflicts with another channel and the next set provides a suitable alternative. Unplayed items are not carried forward, but remain eligible for future sets. New sets prefer items absent from the previous ten sets. When reuse is needed, items from the least recent set are preferred. Smaller libraries may reuse media or produce fewer matches.

Items count as used when Moirai commits them to its schedule, so the displayed remaining count describes schedule preparation rather than what viewers have already watched. A temporarily unavailable or deleted remaining item keeps its place and prevents that set from finishing until the item is available again or you explicitly remove it. Moirai shows a warning instead of silently replacing it.

Removing a channel's schedule clears its Similar Items sets and selection history. Assigning a schedule again starts fresh sets using the current Program settings; other channels keep their sets.

Similarity runs locally on the server. Initial library preparation happens in the background; the Program shows preparation or failure status while waiting for usable matches. If Moirai cannot finish preparing matches, open the Program editor and choose **Retry preparation**. This retries only the failed preparation for relevant media and your current theme, preferences, and exclusions. Items already prepared and active sets stay unchanged. Both container and native builds bundle the model, so installing or running the built application needs no model download or outbound connection. See [configuration](/operations/configuration) for packaging details.

Choose **Review matches** below the sample/excluded previews to search and browse every currently prepared match. Use **Exclude** and confirm to remove an item; find it in **Removed** and choose **Restore** to allow matching again. If preparation is still running, choose **Refresh** to see newly prepared matches.

![Review all matching items and manage individual removals](/screenshots/program-matches-review.png)

Removals and restorations stay in the draft until you save the Program. Saved removals apply to existing and future sets without interrupting playback underway. A set whose remaining items are all removed can advance to a new set. Removals remain until restored, even when you change the theme, source, filters, or library.

## Theme Programs

Theme Programs also provide **Review matches**, with the same **Matches** and **Removed** tabs and save behavior described above.

Choose **Theme** to find media matching a description. Select a **Target library**, use **Configure Filters** to choose which media can qualify, then enter a **Theme**, such as “space exploration and first contact” or “quiet mysteries in small towns.” Matches use the media’s titles, descriptions, and other metadata.

Filters use the same rules as filters elsewhere and are applied before theme matching. For example, require the Comedy genre and enter “raunchy late-night comedies” to rank only comedies by that theme. Leave the filters empty to consider all compatible media.

![Create a Theme Program](/screenshots/program-theme-create.png)

Use **Quantity**, **Cohesion / Variety**, **Preferences**, and **Exclusions** just as you would for Similar Items. Review **Sample matches** and **Excluded matches** as you refine the theme.

Each schedule use keeps its own set and normally finishes it before selecting another, with the same early change for simultaneous duplicates described above. Changes to the theme, target library, library filters, quantity, or refinements apply to the next set. The same preparation status, retry controls, and rotation behavior described below apply to Theme Programs. If a scan corrects a media runtime, the schedule refreshes its future timings at the next daily boundary.

## Sequence Programs

Each child program’s **Selection** and **Playback order** determine which items it contributes. Sequence ordering arranges those selections: **Ordered** and **Shuffled blocks** keep each step’s selections together, while **Shuffled allocations** and **Balanced rotation** may change where they appear within the cycle.

Choose **Sequence** when you want to combine existing ![](/icons/list-video.svg) Programs in a custom order. For example, you could play two items from an episode-selection ![](/icons/list-video.svg) Program, then one item from a movie-selection ![](/icons/list-video.svg) Program.

![Create a Sequence Program with three counted steps referencing different Programs](/screenshots/program-sequence-create.png)

1. Create the ![](/icons/list-video.svg) Programs you want to combine first.
2. In the Sequence editor, choose **Add Step** and select a ![](/icons/list-video.svg) Program.
3. Set the count for that step and add any remaining steps.
4. Use the up and down arrows to arrange the steps.
5. Choose **Ordering**. **Ordered** follows the listed steps. **Shuffled blocks** shuffles steps and keeps each step’s clips together. **Shuffled allocations** mixes clips while keeping each step’s count. **Balanced rotation** spreads clips proportionally and avoids consecutive turns from the same step when possible. **Chance** checks each step independently in the listed order. Shuffle and Chance modes offer an optional **Stable seed**.
6. Enable **Repeat sequence** to begin another cycle after its allocations finish, otherwise it plays only the sequence and leaves any remaining time empty.

### Use Chance ordering

![Sequence ordering with Chance selected and an optional stable seed](/screenshots/program-sequence-ordering.png)

When you choose **Chance**, enter a percentage for each step. A 30% step has a 30% chance to play one clip each cycle. A 0% step never plays, and a 100% step always tries to play. For example, a 100% bumper and a 30% promo average about 23% promos by clip count when both sources can supply clips. With **Repeat sequence** enabled, cycles where every step misses are skipped without taking airtime.

You can assign any Sequence as a **Source Program** for [filler](/filler/presets#keep-filler-varied). The filler preset controls the number of clips or the time available for the break.

### Inspect a Sequence

The inspector’s **Sequence Configuration** shows each source as a numbered block with a media preview and its count or chance. Counted modes show the total configured clips per cycle. Chance shows the most clips that could play in one cycle. A small **more** tile appears after the thumbnails when the source contains additional items. Select a block to inspect that source Program.

![Sequence Configuration with numbered source previews and selections per cycle](/screenshots/program-sequence-inspector.png)

The Programs list and inspector’s source preview sample distinct media from the Sequence’s eligible sources independently of playback order and step counts. Steps set to 0% in Chance mode are excluded from the Sequence’s health, item counts, and source preview.

### Preview a Sequence’s day

The Sequence editor and inspector include a **Guide preview** of one sample day, starting with fresh sequence and child progress. Four hours are visible at a time; scroll horizontally to explore the rest of the day. Each selection shows its title and times. Colors and the numbered legend identify the top-level step for easier verification.

![Sequence guide preview with a four-hour view, colored selections, and numbered entry legend](/screenshots/program-sequence-guide.png)

The sample updates automatically when you change steps, quantities, repeat, ordering, or an active stable seed. Use **Refresh** to manually reload the sample.

This preview does not advance any Channel’s playback progress or predict an existing Channel’s current lineup. A Sequence with **Repeat sequence** disabled leaves a gap after it finishes. Unavailable sources and other scheduling issues appear below the preview.

Each referenced ![](/icons/list-video.svg) Program keeps its own media-selection rules. The Sequence controls how it takes selections from the steps and their counts; it does not assign clock times. The ![](/icons/calendar-range.svg) Template it's placed in decides when it runs.

For complete setup recipes, see [Example schedules](/scheduling/example-schedules). Counts are per cycle, not per day.

## Preview, save, and delete

The editor preview is safe to explore. Save only when the draft is valid and matches the intended audience. Deleting a program is permanent and can make template slots invalid, so inspect its usage before confirming deletion.

All Program types retain pending edits automatically in this browser. Close the editor, navigate elsewhere, or reload, then reopen the same Program or New Program to continue. **Add** creates a new Program; **Save** commits pending changes. **Reset**, once confirmed, discards pending changes and restores the latest saved values.

## Guide and graphics metadata

Open **Guide and graphics metadata** in any Program editor and choose **Add field**. For example, an actor showcase Program might enter `showcase_actor` as the key and the actor’s name as the value. Use letters, digits, and underscores in keys. Keys are case sensitive and must be unique within the Program. Each Program can have up to 16 fields, with keys up to 64 characters and values up to 256 characters.

![A Program with a showcase actor field for guide templates and graphics](/screenshots/program-guide-metadata.png)

Using this example, you'd use <code v-pre>{{ program.metadata.showcase_actor }}</code> in a [guide template](/playback/guide-templates) or <code v-pre>{{ now.program.metadata.showcase_actor }}</code> in a [graphics text layer](/playback/graphics). Editing just the metadata updates existing guide listings and future graphics preparation while keeping the current rotation and selected movies.

Fields from a Sequence also apply to its children. A child can replace an inherited field by using the same key, or suppress it with a blank value. Removing the child’s field restores inheritance.


## Audio and subtitles

Programs can have their own audio and subtitle preferences, independently of the Channel they appear on. Set an override to use the Program's preference wherever it plays, or leave a field set to inherit so it follows the enclosing Sequence Program or Channel, including any [global audio defaults](/settings/playback#audio-selection-defaults) inherited by the Channel.

![Expanded Program audio and subtitle settings showing inherited preferences and music video credits](/screenshots/program-subtitles.png)

Open the optional **Audio and subtitles** section below the main configuration steps.

### Audio selection

Use **Preferred language code** (such as `en` or `eng`) and **Preferred audio title** to override the [Channel's audio preferences](/scheduling/channels). A title matches part of an audio track's name, ignoring case; it is not a regular expression. Moirai checks plain and language-tagged Matroska track titles and MP4 handler names, including alternate names that are not displayed.

Each field inherits independently from the Channel through enclosing Sequence Programs to the Content Program. Leave a field blank to inherit, or enter `*` to remove the inherited preference for that field. For example, a Sequence can prefer French while a Content Program clears the inherited title preference and keeps French.

Selection prefers matching language, then matching title. Without a matching title, it prefers tracks that are not marked as commentary or audio description when available. An explicit title match can still select those tracks. Remaining ties prefer default-flagged tracks, more audio channels, and the lowest stream index. A missing match falls back to other available audio; it does not silence the video. With both effective preferences cleared, the playback engine selects audio normally.

Scheduled filler follows its own captured program ancestry, and multipart videos select each physical file separately. Saving preferences preserves program selection progress and does not restart the current item.

### Subtitles and music video credits

The subtitle controls follow Audio selection in the same optional section.

Subtitles and music video credits are optional. They're for different purposes but share settings and presentation.

Subtitles come from embedded or sidecar subtitle data. Moirai uses subtitle tracks discovered during library scanning; see [subtitle sidecar naming](/libraries/media-file-naming) if matching files are not appearing in the media details.

Music video credits use metadata about the content itself to generate and render opening and closing classic music video style credits. They're intended for content like music videos where movie/show-style subtitles are not used.

### Inherit or override

Programs start with subtitle selection, language, title, and music video credits set to **Inherit**. Each field inherits independently from the containing Sequence Program, or from the [Channel](/scheduling/channels) when no containing Program supplies a value. A more-specific Program overrides its containing sequence.

For example, a Channel can prefer English subtitles, a Sequence can enable music video credits, and a Content Program within it can turn credits Off while retaining the inherited subtitle policy and language. A reusable Program with inherited settings can therefore behave differently on different Channels.

Changing only subtitle or credit preferences preserves playback progress, including a sequence's current position and completion state.

### Subtitle behavior

Choose a **Subtitle behavior** mode, then set the language and title rules below it. You can use **Check against media** to see how a specific video will select its subtitle track based on your settings. Inherited rules depend on the enclosing Program or Channel where this Program plays.

- **Inherit selection:** use the selection policy from the containing Program or Channel.
- **Off:** disable ordinary subtitles for this Program even if they are enabled in the inherited settings. Music video credits can still be enabled separately.
- **Forced only:** select a matching track marked **forced**. These tracks commonly translate foreign-language dialogue or signs rather than every spoken line. The track must carry the forced flag; Moirai does not infer it from the dialogue. If no matching forced track exists, the video plays without ordinary subtitles.
- **Prefer default:** prefer a matching track marked **default**. If none is marked default, select another matching track. Use this when your files already identify the subtitle track you normally want.
- **Any matching track:** select an available track that matches the language and title settings. This selects one track only and does not send every available language to the viewer.

If several tracks qualify, Moirai prefers a track associated with the current physical part of a multipart video, then an embedded track over a sidecar. Prefer default checks the default flag before these tie-breakers. Selection is consistent between runs; it does not combine tracks or offer a track picker here. Hearing-impaired and commentary flags are recorded during scanning but are not separate selection filters.

### Subtitle language

Under **Selection rules**, choose **Inherit language** to follow the enclosing Program or Channel, or **Any language** to remove the inherited language constraint and allow tracks with any language, including untagged tracks. Choose **Specific language** to search a language name or enter a two- or three-letter code, such as `en` or `eng`. If a name also matches a different language’s code, choose the intended language from the list before saving.

A specified language is a strict filter. For example, **Forced only** with `en` selects an English forced track; an English non-forced track or a French forced track does not qualify. If no track matches, Moirai omits ordinary subtitles instead of falling back to another language. Tracks with an unknown language do not satisfy an explicit language choice.

### Subtitle title contains

Choose **Specific title** under **Subtitle title rule**, then use part of a recorded track title, such as `Signs` or `Forced`, to distinguish tracks in the same language. Matching ignores case and treats the text literally; it is not a regular expression. Check the media details for the recorded titles. Untitled tracks cannot match a requested title, and sidecar filenames are not used as titles.

The title, language, and selection policy must all match. **Forced only** requires the file’s forced flag, even when a track is titled `Forced`. Choose **Any matching track** to select a track by title without requiring that flag. If no eligible track matches the requested title, the video plays without ordinary subtitles and the Channel editor reports a preparation issue. If preparation fails, retries stay within the title match.

Choose **Inherit title rule** to follow the enclosing Program or Channel, or **Any title** to remove an inherited title constraint. Each field inherits independently: choosing Inherit selection does not clear a specific language or title rule.

### Check against media

Expand **Check against media** to test the rules against one video before saving. Choose a library and search for the item you'd like to test -- the poster carousel shows the first 12 matching videos. Select a video card to check its subtitles automatically. The check uses the Program’s current draft settings and your chosen inheritance context.

Choose a **Preview channel** to supply inherited defaults. Leave the context directly on the Channel, or add containing Sequence Programs from the inside out. The breadcrumb shows the final outer-to-inner order.

![Subtitle preview disclosure with inheritance context and video search](/screenshots/program-subtitle-preview.png)

The result highlights the selected track, followed by ranked eligible alternatives and excluded tracks. Exclusions explain mismatched language or title, another physical part, a missing forced flag, or subtitles being Off. Music video credits take priority when configured for the chosen music video.

This checks scanned metadata only. It does not inspect subtitle contents, check timing, or prove that preparation or rendering will succeed. An empty subtitle track can still be selected. VobSub sidecar streams are resolved during preparation, so the preview warns when their indexed selection may differ.

### Music video credits

- **Inherit:** use the credit-template setting from the containing Program or Channel.
- **Off:** disable credits for this Program even if inherited settings enable them. Ordinary subtitles can still appear according to the selection policy and language.
- **On:** choose a reusable [credit template](/playback/credit-templates) to display music video metadata such as the artist and song title for music videos selected by this Program.

Credits work independently of ordinary subtitles and can display even when **Subtitle behavior** is Off, and the preferred subtitle language and title do not apply to generated credits. Use **Playback → Credit Templates** to view, duplicate, or customize templates.

### Presentation follows the Channel

**Subtitle mode** and **Subtitle fonts folder** are configured in the [Channel editor’s Presentation section](/scheduling/channels), not on individual Programs. **Burn** renders subtitles into the picture, so viewers cannot switch them off. **Convert** provides selected text subtitles as a selectable WebVTT track for compatible players; image-based subtitles such as PGS or VobSub are still burned. The Channel's optional fonts folder supplements installed system fonts for subtitles in ASS format, including generated credits.

Music video credits enabled on a Program in the prepared schedule automatically force **Burn** for the whole Channel, including ordinary subtitles on other videos. The Channel's saved Convert preference is retained and restored when credits are no longer enabled in that schedule. Turning credits Off on one Program does not restore Convert if other effective settings still enable credits. A running stream restarts when the effective mode changes, so enabling or disabling credits can briefly interrupt viewing.

### Check the result

Save the Program and test a scheduled video with a known matching subtitle track. Check the Channel editor for preparation issues if subtitles or credits are missing. If preparing a subtitle fails, Moirai tries up to two further eligible tracks while retaining your language, title, and forced-only requirements. Failed attempts remain visible in preparation issues. If no candidate succeeds, or credit preparation fails, Moirai publishes the video without that content; a busy credit renderer retries during a later update. A subtitle that passes preparation can still encounter a decoding or rendering failure in the playback engine, so verify the result with your actual files and IPTV client.
