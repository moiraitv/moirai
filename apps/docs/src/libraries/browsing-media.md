---
id: libraries.browse
title: Browse and filter media
description: Find indexed media, inspect details, and select items for programs.
contextual: true
---

# Browse and filter media

Open a library to browse its indexed catalog. Search narrows the current results by name. Sorting, date windows, and filters help with larger collections.

Music video libraries browse through **Artists → Albums → Songs**, just as show libraries browse through shows and seasons. Open an artist to see their albums, then an album to see its songs. Use the breadcrumbs or browser Back button to move up. Artist and album cards show how many albums or songs they contain.

Use title sorting with no active filters to browse the hierarchy. Search, filters, and other sort modes show matching songs within the current artist or album.

When browsing by title, select a letter above the catalog to jump to that section. On touch screens, swipe the letter strip sideways to reach additional letters.

![An indexed media library](/screenshots/library-catalog.png)

The filter editor can include or exclude genres and apply facts such as actors, directors, ratings, and dates when those values exist in the source metadata. An empty result means nothing matches the whole active filter; it does not mean the library is empty.

Select ![Filter media](/icons/funnel.svg) above the catalog to open these controls, then choose **Apply Filters** to update the results. **Clear All** clears the choices in the filter editor.

![Filter media editor showing genre choices, title search, release year, and added-date controls](/screenshots/library-filters.png)

The same filters are available in Quick Setup and program library queries. Use **Match all** when every selected genre must be present or **Match any** when one is enough; excluded genres remove matching items. Release-year and indexed-date filters answer different questions: when the media was released versus when Moirai added it to the catalog.

Use the eye button in the upper-left corner of a media card for a quick preview. It appears on hover or keyboard focus on desktop and stays visible on touch devices.

Open an item to inspect its artwork, plot, credits, source paths, subtitles, and technical playback details. Missing information usually means it was absent from the NFO file or media probe.

![Indexed media details](/screenshots/media-item.png)

Open **Used by** at the right edge of the item page to see programs that select it directly or currently match it through a library query. **Playing at** lists current and upcoming showings on channel schedules, with channel names and start/end times.

![Media usage and realized showings](/screenshots/media-item-usage.png)

Selection mode lets you choose shows, seasons, artists, or albums and add them to a new or existing selected-groups program. For example, open a show, choose **Select groups**, select seasons 1–8, then choose **Add Selected**. Name a new program and leave **Playback order** set to **Sequential** to play only those seasons in episode order. Newly indexed episodes within the selected seasons join automatically.

**Select Page** selects the groups or items on the current page. If a page contains both groups and individual items, choose **Groups** or **Items** in the selection toolbar; changing the kind clears the current selection. The destination dialog only offers compatible programs from the same library, and skips references already selected.

![Library selection mode with two movies selected and the Add Selected, Add All, and Select Page controls](/screenshots/library-selection.png)

**Add All Items** remains available while selecting groups and includes every item beneath the current level, including items on other pages. It adds individual items to a selected-items program. In item selection mode, this action is labeled **Add All** and includes all items matching the current filter recursively. Check the displayed match count before adding a broad selection.
