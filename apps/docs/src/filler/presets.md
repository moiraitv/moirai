---
id: filler.presets
title: Filler presets
description: Add introductions, intermissions, closings, and tail filler to your schedules.
contextual: true
---

# Filler presets

Open **Filler** below **Scheduling** to manage **Pre-Rolls**, **Mid-Rolls**, **Post-Rolls**, and **Tail Fillers**. A preset defines the amount and fitting behavior only. You choose the **Source Program** separately when assigning it.

**Pre-Rolls** play before each primary item, **Post-Rolls** play after each primary item, and **Tail Fillers** run once after primary programming ends within the remaining slot time. **Mid-Rolls** insert breaks inside an item based on the [break conditions](#mid-roll-break-conditions).

::: info What the settings mean

- **Budget:** How much filler to play each time: a length of time, a number of clips, or enough to reach a clock or slot boundary. For mid-roll, this applies to each break.
- **Pad to clock:** Add filler until the next clock boundary. For example, a 15-minute setting aims for :00, :15, :30, or :45.
- **Fitting Behavior:** What to do when clips do not fit the time left. **Whole Items Only** leaves clips uncut and can end filler early. **Allow Truncation** can cut a clip short if no complete clip fits.
- **Timed fallback interval:** How far apart possible mid-roll breaks are when the video has no usable chapter boundaries. For example, 600 seconds means every ten minutes. Break conditions still decide which of these breaks are allowed.
- **Point:** A place where a mid-roll break could happen, at a chapter boundary or a timed interval. The end of the video is not a point.
- **Break conditions:** Rules that decide whether to allow a break at each point. **All conditions** means every rule must match; **Any condition** means at least one must match.
- **Accepted point:** A point that passes the break conditions. **Point Number** counts all possible points from one; **Previously Accepted Points** counts only earlier points that passed the rules.
- **Content time and progress:** How much of the main video has played or remains. These values do not include filler time. **Since Last Accepted Break** measures main-video time since the last accepted point, or since the video started if there has not been one yet.
- **Chapter title:** The name of the chapter ending at a point. A title condition must match that name exactly. Timed points have no chapter title.

:::

## Create a preset

Several read-only built-ins are provided and available for use. Choose **View** to inspect one or **Duplicate** to customize it. You can also create one from scratch by choosing **New**. Editing a preset affects every assignment using it; existing committed airings finish before pending changes apply. Presets in use cannot be deleted.

Choose a budget:

- **Fixed duration** supplies up to the configured number of seconds.
- **Pad to clock** fills to the next selected minute boundary in the channel’s time zone (e.g., a 15-minute interval targets :00, :15, :30, or :45.) Starting exactly on a boundary needs no filler. Each stage calculates its own target at its actual start, including time occupied by earlier filler.
- **Fixed quantity** plays a specific number of complete items.
- **Random quantity** chooses an inclusive minimum-to-maximum count for each break. Zero allows a break to be skipped. The count stays consistent between preview and committed generation for the same scheduling inputs.
- **Fill remaining slot**, available only for Tail Fillers, fills until the resolved next-slot boundary.

Duration, clock padding, and remaining-slot budgets offer **Fitting Behavior**. **Whole Items Only** chooses the first unused item in the Source Program’s order that fits. If nothing fits the remaining time, content resumes early. **Allow Truncation** also searches for a complete fitting item first, then trims the first queued item if none fits. Existing best-fit settings adopt these same behaviors; filler no longer selects an item just because it is the longest fit.

### Keep filler varied

Filler sources can use Content, Similar Items, or Theme Programs. Each filler assignment has its own queue, so one channel playing a filler item does not prevent another from using it too. Played items leave that queue and cannot repeat until its eligible items are exhausted.

Items that are too long stay at their current queue positions. When no queued item fits the full break budget, Moirai appends a new eligible cycle behind them without including deferred items. A later, larger gap can potentially play those deferred clips. If an unused item fits the full budget but not the remainder of this break, it waits for a later break instead of starting a new cycle. A truncated clip counts as played.

Pre-roll, mid-roll, post-roll, tail, and channel fallback retain independent progress for each slot assignment.

![Random quantity budget with minimum and maximum item controls](/screenshots/filler-random-budget.png)

![Clock padding budget and fitting policy](/screenshots/filler-clock-budget.png)

## Mid-Roll break conditions

Open **Filler → Mid-Rolls** to create or edit a mid-roll preset. Along with its budget, choose where breaks are allowed. The built-in **Two-minute breaks** preset supplies up to 120 seconds of whole filler clips at each allowed break; **One-item breaks** plays one complete clip. Both leave at least ten minutes before the first break and between allowed breaks, plus at least two minutes of content after a break.

Videos with usable chapter boundaries use those points. Otherwise, **Timed fallback interval (seconds)** sets possible breaks at regular intervals. A rule that excludes every chapter point does not switch to timed breaks.

![Break conditions checking elapsed time, spacing, and remaining content](/screenshots/mid-roll-predicate.png)

Choose **All conditions** when every rule must match, or **Any condition** when at least one must match. Use **Condition** to add a rule or **Group** to combine rules. **Exclude** reverses a rule: a point that would match is excluded instead.

- **Numeric comparison** checks content time, progress, or point counts. Time excludes filler, progress uses percentages, and point numbers start at one. **Since Last Accepted Break** measures content time since the previous point that passed all the break rules, or since the video started if none has passed yet.
- **Every Nth point** picks regularly numbered points. An interval of two with a remainder of zero picks points 2, 4, 6, and so on.
- **Chapter title** matches the name of the chapter ending at that point, including capitalization. Timed points have no chapter title.
- **Always** allows every point, unless **Exclude** is checked.

For example, consider these three numeric rules under **All conditions**: elapsed content of at least 600 seconds, at least 600 seconds since the last accepted break, and at least 120 seconds of content remaining. This keeps breaks ten minutes apart and avoids a break near the end.

Rules can contain up to 100 conditions and groups, nested up to eight levels. Each video uses at most 256 possible break points. If the Source Program cannot supply the requested filler, content resumes immediately and schedule diagnostics report the shortfall. Tail filler can still fill time left in the slot afterward.

## Assign filler

In a template or channel schedule, the combined filler interface shows a 137-minute example movie with sample gaps before, during, and after the content. Select **Pre-Roll**, **Mid-Roll**, **Post-Roll**, or **Tail Filler** to highlight the corresponding location it refers to and show its controls. You can also select a gap directly. 

To activate a type of filler, check the selected type’s checkbox, then choose its **Preset** and **Source Program**. Unchecking it deactivates it. Each programmed slot can inherit, disable, or override each filler type independently. Template defaults take precedence over channel defaults.

For a slot override, open **Advanced scheduling behavior**, select the filler type under **Slot filler**, and choose **Slot override**. Unchecking its assignment returns that type to inheritance. See [Templates](/scheduling/templates) and [Channel schedules](/scheduling/channel-schedules). **Apply after current item** waits for the episode or movie and its pre-roll, mid-roll, and post-roll filler to finish. Renaming a preset or changing its description does not change playback.

The movie illustration uses the selected Mid-Roll’s timed interval and guided conditions. It has no chapters, so chapter-name conditions may produce no matching breaks. Quantity budgets use example 30-second items; random quantities show the midpoint of the configured range. Clock padding assumes a 20:03 start, and remaining-slot tail ends at the next half-hour.

Pre-roll, mid-roll, and post-roll time count toward the primary item’s fit and appear with that item in the guide. Tail filler never postpones incoming programming. No-program slots use channel fallback only.

After tail finishes, **Channel fallback filler** can cover the remaining gap. Disabling tail does not disable fallback. The managed playback fallback video remains available for playback gaps and errors.

If filler leaves a gap, schedule diagnostics point to the applicable filler assignment.
