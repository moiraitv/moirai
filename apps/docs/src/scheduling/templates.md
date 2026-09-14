---
id: scheduling.templates
title: Templates
description: Arrange programs into a reusable day structure.
contextual: true
---

# ![](/icons/calendar-range.svg) Templates

> [!INTRODUCTION]
>
> ## ![](/icons/introduction-template.svg) What is a template?
>
> A template defines how a channel’s 24-hour day is structured using reusable schedule slots. Reuse templates across channels and dates to keep schedules consistent and easy to manage.
>
> ### Templates help you
>
> - ![](/icons/introduction-clock.svg)
>
>   **Plan a nominal day**
>
>   Allocate time across slots without worrying about actual media durations.
>
> - ![](/icons/introduction-eye.svg)
>
>   **Preview resolution**
>
>   See how slots resolve with real media durations and boundary policies.
>
> - ![](/icons/introduction-repeat.svg)
>
>   **Reuse everywhere**
>
>   Use the same template across channels, rotations, and seasons.


In a saved template, **Used by** lists channel schedules that assign it as a base or conditional template. Direct references do not include every indirectly affected channel.

A ![](/icons/calendar-range.svg) Template divides a nominal day into slots. Each slot starts at an authored time and normally uses one ![](/icons/list-video.svg) Program. ![](/icons/tv-minimal-play.svg) Channel Schedules can reuse the same ![](/icons/calendar-range.svg) Template on many dates or layers.

The Templates list is alphabetical by name, ignoring punctuation and leading “A”, “An”, or “The”, just like Programs and media titles.

![The templates catalog](/screenshots/templates.png)

## Create a Template and add slots

Create the ![](/icons/list-video.svg) Programs you want to use first, then open ![](/icons/calendar-range.svg) Templates and choose **New Template**. Give it a descriptive name, such as “Evening Cinema Day.” A new ![](/icons/calendar-range.svg) Template starts with one slot covering midnight to midnight. Timeline and slot labels use 12-hour time with AM or PM.

1. Select the initial slot and choose its **Program** in the **Selected slot** panel.
2. Choose **Add Slot**. Move over the timeline to choose where to divide an existing slot, then click to place the new boundary. With a keyboard, use the arrow keys to adjust the proposed position and Enter to confirm; Escape cancels.
3. Select the new slot and choose its **Program**. Adding a slot divides the existing time rather than extending the day.
4. Set **Starts** to the exact time you want. You can also drag the boundary between slots on the timeline. The first slot stays at midnight (12:00 AM); each slot ends where the next begins, and the last ends at the following midnight.
5. Repeat for the remaining parts of the day. Switch to **List** if you prefer selecting slots from rows instead of the timeline.

![Template creation editor with three slots, selected-slot controls, and a resolved preview](/screenshots/template-editor.png)

> ![Information](/icons/info.svg) **Program colors are visual identifiers only.** They help you see which ![](/icons/list-video.svg) Program supplies each slot or media item. The color does not indicate priority, playback order, or scheduling behavior.

This example has three slots and preview warnings where the selected movies leave gaps. Adjust the slot rules or filler before relying on the lineup.

To remove a slot, select it and activate **Delete selected slot** twice to confirm the draft change. You cannot remove the final remaining slot. **Reset** discards pending edits after confirmation; **Save** stores the valid draft and closes the editor. If saving fails, the editor stays open with your changes.

## Choose how a slot appears in the guide

![Slot guide title, description, and timing controls](/screenshots/template-slot-guide.png)

In the selected slot, use **Guide output → Single block** to show one listing such as “Rock Music” instead of each video. Leave **Guide title** empty to use the slot’s program name, or enter a custom title such as “Rock Music”. Optionally add a description, and choose **Guide timing**:

- **Scheduled boundaries** uses the slot’s scheduled start and end. A slot scheduled for 8–9 stays at 8–9 in the guide even if its content runs 8:02–9:04, or none of its content plays.
- **Include drift** follows the slot’s actual start and finish, including filler and gaps. In that example, the listing runs 8:02–9:04. A completely displaced slot has no listing in this mode.

The resolved schedule preview shows the same guide blocks and timing as the Guide page, including unsaved changes. Hover, focus, or tap a block to see the actual items within it.

Saving these settings immediately updates the Guide page and XMLTV output without changing playback or content selection. **Individual items** restores the usual listings. Higher-priority schedule layers split the lower slot’s listing; fall-through slots use the lower layer’s settings. Scheduled boundaries take priority over overlapping listings, which are shortened in the guide only.

Hover over a guide block to see a 30-minute zoomed timeline of its actual items, centered near the time under the pointer. Move along the block to inspect another time. The crop keeps the Guide’s item colors and clips items at the displayed time boundaries. Item labels show the source program name, or **Filler** or **Gap** when appropriate.

## Configure what a slot plays

The **Program** choice supplies the content-selection rules for the slot. The adjacent **Edit** button opens that reusable ![](/icons/list-video.svg) Program, so changes can affect other places that use it too.

Choose **No program — fall through** when this part of a layered schedule should leave room for a lower-priority layer (used by ![](/icons/tv-minimal-play.svg) Channel Schedules). This does not provide media by itself; check the resolved preview to see what actually fills the time.

Open **Advanced scheduling behavior** on a slot with a ![](/icons/list-video.svg) Program to configure playback state, item starts, its outgoing boundary, and filler.

### Playback state and item starts

![Selected-slot playback state and item start rule controls](/screenshots/template-slot-playback.png)

**Playback state** determines whether selection continues from its saved position (**Continue persistently**) or starts over for each day's occurrence (**Restart each day**).

**Item start rule** determines whether another item may begin near the end of the slot:

- **Require complete fit** only starts an item that fits in the available time.
- **Allow truncation** permits starting an item that may need to be cut short.
- **Allow overrun** permits starting an item that may run beyond the normal slot end.
- **Within drift** uses the configured **Start drift (minutes)** allowance when deciding whether an item may start.

The item start rule and outgoing boundary work together. Allowing an item to start does not guarantee it will play to completion.

### Handle the end of a slot

![Outgoing boundary controls showing policy, maximum drift, and fallback](/screenshots/template-slot-boundary.png)

Real media rarely ends exactly on a slot boundary. Under **Outgoing boundary**, choose how the handoff to the next slot should work:

- **Hard boundary** keeps the handoff at the authored time; content that crosses it may be cut.
- **Finish left item** favors finishing the item in the outgoing slot, subject to the configured drift and fallback.
- **Favor right slot** favors handing over to the following slot, potentially before the nominal boundary.

**Maximum drift** controls how far the handoff may move. The fallback controls what happens when that allowance cannot be honored, such as rejecting an item start or truncating the outgoing item. Use the preview to check the combined effect rather than choosing these settings independently.

### Fill remaining time

![Slot filler override with Program and selection policy controls](/screenshots/template-slot-filler.png)

Filler can occupy time that the main ![](/icons/list-video.svg) Program cannot fill. A slot can inherit the ![](/icons/calendar-range.svg) Template or ![](/icons/tv-minimal.svg) Channel settings, disable filler, or use a **Slot override** with its own filler ![](/icons/list-video.svg) Program.

The filler choices distinguish finding a fitting item from taking the next item, and whether cutting an item is allowed: **Best fit or truncate**, **Best fit only**, **Next and truncate**, or **Next only if it fits**. Configure **Template default filler** when several slots should share the same filler rule.

## Preview and use the Template

![Resolved Template preview with scheduled media, gaps, and preview issues](/screenshots/template-preview.png)

Use the resolved preview to see actual start and finish times rather than relying only on the authored grid. Warnings call out missing media, invalid durations, and gaps that would otherwise become dead air.

Save the ![](/icons/calendar-range.svg) Template, then assign it through a ![](/icons/tv-minimal-play.svg) [Channel Schedule](/scheduling/channel-schedules). Saving a ![](/icons/calendar-range.svg) Template alone does not assign it to a ![](/icons/tv-minimal.svg) Channel.

Keep templates focused on a reusable daily structure. Date-specific choices belong in channel schedule layers rather than copies of nearly identical templates.
