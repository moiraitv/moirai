---
id: scheduling.programs
title: Programs
description: Choose media and control the order in which a schedule uses it.
contextual: true
---

# Programs

A program is a reusable rule that tells Moirai what content to play and in what order. Templates use
programs in their time slots, so one program can appear on several channels or days.

![The programs catalog](/screenshots/programs.png)

Use an explicit sequence when you want a hand-authored list. Use a selection-based program when the
eligible items should come from library rules and can change as the library changes.

Library queries share the catalog filters: title, release year, indexed date, rating, actors,
directors, and included or excluded genres. Choose **Configure Filters** to refine the matches.
Order the query by title/episode, indexed date, or release date, in either direction, and optionally
limit the ordered set. The media carousel updates as scanning adds or changes matching items.

The item limit applies before unusable or unavailable media is excluded. If some of the limited
items cannot play, Moirai does not replace them with matches outside that limit. Query ordering
defines the candidate set; the selection strategy below controls playback through that set.

Ordering controls how eligible items are consumed. Sequential order follows the configured order;
shuffle cycles through a repeatable shuffled pool; random selection makes a repeatable choice for
each step. Options for avoiding repeats or preferring unseen content refine that choice without
turning a preview into a saved playback checkpoint.

The editor preview is safe to explore. Save only when the draft is valid and matches the intended
audience. Deleting a program is permanent and can make template slots invalid, so inspect its usage
before confirming deletion.
