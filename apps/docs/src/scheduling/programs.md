---
id: scheduling.programs
title: Programs
description: Choose media and control the order in which a schedule uses it.
contextual: true
---

# ![](/icons/list-video.svg) Programs

A ![](/icons/list-video.svg) Program is a reusable rule that tells Moirai what content to play and in what order. ![](/icons/calendar-range.svg) Templates use ![](/icons/list-video.svg) Programs in their time slots, so one ![](/icons/list-video.svg) Program can appear on several ![](/icons/tv-minimal.svg) Channels or days.

![The programs catalog](/screenshots/programs.png)

## Content Programs

Choose **Content** when the ![](/icons/list-video.svg) Program should select media from a library. You can choose the media yourself or use a query that finds matching items as the library changes.

![Create a Content Program with a populated library query](/screenshots/program-content-create.png)

### Choose specific media

Use an explicit selection when you want to control which items are eligible. Review the selected media and arrange its order before choosing how playback moves through it. A hand-picked list of media is still a Content ![](/icons/list-video.svg) Program; a Sequence ![](/icons/list-video.svg) Program combines other ![](/icons/list-video.svg) Programs instead.

### Use a library query

Library queries share the catalog filters: title, release year, indexed date, rating, actors, directors, and included or excluded genres. Choose **Configure Filters** to refine the matches. Order the query by title/episode, indexed date, or release date, in either direction, and optionally limit the ordered set. The media carousel updates as scanning adds or changes matching items.

The item limit applies before unusable or unavailable media is excluded. If some of the limited items cannot play, Moirai does not replace them with matches outside that limit. Query ordering defines the candidate set; the selection strategy below controls playback through that set.

### Choose the playback order

The **Selection** controls determine how eligible items are consumed:

- **Sequential** follows the configured order.
- **Shuffle (no repeats)** uses a shuffled order without repeating an item until the pool has been played.
- **Random** chooses an item each time, so repeats are possible.
- **Weighted random** favors content your viewers have chosen while retaining variety.

The optional **Stable seed** makes randomized choices repeatable. Whether playback continues from its previous position or restarts each day is configured in the ![](/icons/calendar-range.svg) Template slot, under **Advanced scheduling behavior**.

## Sequence Programs

Choose **Sequence** when you want to combine existing ![](/icons/list-video.svg) Programs in a custom order. For example, you could play two items from an episode-selection ![](/icons/list-video.svg) Program, then one item from a movie-selection ![](/icons/list-video.svg) Program.

![Create a Sequence Program with three counted steps referencing different Programs](/screenshots/program-sequence-create.png)

1. Create the ![](/icons/list-video.svg) Programs you want to combine first.
2. In the Sequence editor, choose **Add Step** and select a ![](/icons/list-video.svg) Program.
3. Set the count for that step and add any remaining steps.
4. Use the up and down arrows to arrange the steps.
5. Enable **Repeat sequence** if the sequence should start again after its final step.

Each referenced ![](/icons/list-video.svg) Program keeps its own media-selection rules. The Sequence controls their order and counts; it does not assign clock times. Place it in a ![](/icons/calendar-range.svg) Template to decide when it runs.

## Preview, save, and delete

The editor preview is safe to explore. Save only when the draft is valid and matches the intended audience. Deleting a program is permanent and can make template slots invalid, so inspect its usage before confirming deletion.
