---
id: scheduling.channel-schedules
title: Channel schedules
description: Assign a base template and conditional layers to a channel.
contextual: true
---

# ![](/icons/tv-minimal-play.svg) Channel schedules

> [!INTRODUCTION]
>
> ## ![](/icons/introduction-layers.svg) What is a channel schedule?
>
> A channel schedule layers reusable templates into one resolved lineup. Start with an always-available base, then add conditional programming for specific days, dates, seasons, or hours.
>
> ### Channel schedules help you
>
> - ![](/icons/introduction-layers.svg)
>
>   **Keep a reliable base**
>
>   Supply normal programming whenever no higher conditional layer applies.
>
> - ![](/icons/introduction-calendar.svg)
>
>   **Target special times**
>
>   Combine calendar and time predicates for seasonal or recurring programming.
>
> - ![](/icons/introduction-preview.svg)
>
>   **Preview the result**
>
>   Inspect the concrete lineup after template priority and boundaries resolve.




A ![](/icons/tv-minimal-play.svg) Channel Schedule chooses which ![](/icons/calendar-range.svg) Templates apply to one ![](/icons/tv-minimal.svg) Channel. Start with a base ![](/icons/calendar-range.svg) Template, then add conditional layers when particular dates or times need different programming.

## Choose the base Template

Open the ![](/icons/tv-minimal.svg) Channel's schedule editor, select the base at the bottom of the **Template stack**, and choose its **Base template**. This supplies normal programming wherever no higher-priority layer provides content.

![Channel Schedule editor with a base Template and a resolved preview](/screenshots/channel-schedules.png)

## Add a conditional Template

A conditional ![](/icons/calendar-range.svg) Template is a reusable day structure with a rule controlling when it applies here. For example, a weekend evening layer can replace ordinary programming on Saturday and Sunday from 18:00 to 23:00 without changing the rest of the week.

1. Create the ![](/icons/calendar-range.svg) Template you want to use, with its slots at the intended times of day.
2. Choose **Add Conditional Template** in the schedule editor. A new layer is inserted at the top of the stack.
3. Select the **Conditional layer template** in the right-hand panel.
4. Set **Show this layer when** to the dates and times that should activate it. A newly added layer initially matches every weekday, so narrow this rule before saving if it is meant to be an exception.
5. Configure the layer's entry and exit boundaries, then preview matching and nonmatching dates.

![Conditional Template selected above the base with weekend and evening conditions](/screenshots/channel-schedule-conditional.png)

The stack runs from highest priority at the top to the base at the bottom. Use the up and down arrows to resolve overlaps: the highest matching layer that supplies a ![](/icons/list-video.svg) Program wins at that time. A **No program — fall through** slot lets lower layers provide content. A programmed slot that cannot find playable media is not the same as a deliberate fall-through slot; inspect preview warnings and filler settings.

The condition limits when the layer is eligible; it does not move the ![](/icons/calendar-range.svg) Template's slots to a new clock time. **Edit Template** changes the shared ![](/icons/calendar-range.svg) Template, including other schedules that use it. Removing a layer removes this assignment, not the underlying ![](/icons/calendar-range.svg) Template.

## Use the predicate editor

A *predicate* is simply a condition that must match for a layer to apply. Under **Show this layer when**, choose a condition type and fill in its values.

![Predicate editor combining weekend days and an evening time range with All conditions](/screenshots/channel-schedule-predicates.png)

- **All conditions** requires every child condition to match. Use it for “weekend **and** evening.”
- **Any condition** requires at least one child to match. Use it for alternatives such as “Saturday **or** an exact holiday date.”
- **Months** and **Weekdays** match the selected months or days. Selecting both Saturday and Sunday in one Weekdays condition means either day matches.
- **Exact dates** takes comma-separated dates in `YYYY-MM-DD` form.
- **Date range** includes both its start and end dates.
- **Recurring annual range** takes `MM-DD` endpoints and repeats each year. It can cross New Year, such as `12-20` through `01-05`.
- **Time range** matches local clock time from the start up to, but not including, the end. A range such as 22:00–02:00 crosses midnight.

Use **Condition** to add another rule to a group, or **Group** to nest an All/Any combination. **Exclude** reverses an individual condition—for example, exclude exact holiday dates from an otherwise matching weekend rule. Changing a condition's type replaces its values with defaults, so check the new values afterward.

For the example shown, keep the top group as **All conditions**, select only **Sat** and **Sun** in a Weekdays condition, then add a Time range of **18:00–23:00**. With **Any condition** instead, the layer would apply throughout the weekend and during those evening hours on other days too.

Conditions use Moirai's configured scheduling time zone. Preview both sides of midnight for overnight rules, and check the dates where seasonal rules begin or end.

## Boundaries and overrun

Layer boundaries control transitions between priorities, while the slot boundaries inside a ![](/icons/calendar-range.svg) Template control transitions within that day structure.

- **Entry boundary** governs lower-priority content already playing when this layer begins.
- **Exit boundary** governs this layer's outgoing content when it ends and lower-priority programming resumes.

![Entry and exit boundary controls, with a fifteen-minute entry overrun allowance](/screenshots/channel-schedule-boundaries.png)

Choose **Boundary behavior** separately for entry and exit:

- **Hard boundary** keeps the authored handoff time; an item crossing it may be cut.
- **Finish outgoing item within drift** lets the outgoing item finish within the allowed delay.
- **Favor incoming content** prioritizes the incoming programming rather than preserving the outgoing item at all costs.

**Maximum drift past boundary (minutes)** limits how far outgoing content may delay incoming programming. For example, a 15-minute allowance at an 18:00 entry permits a handoff as late as 18:15. **No limit — always finish outgoing item** removes that cap; use it only when finishing the current item matters more than the next block's punctual start.

The fallback labeled **If the next outgoing item cannot satisfy this boundary** controls what happens when the next item cannot meet the rule: **Truncate outgoing content**, **Do not start it**, or, with a finite finish-outgoing policy, **Start incoming content early**. The latter has a separate **Maximum early start (minutes)** allowance. With unlimited drift, the fallback is disabled because the outgoing item is allowed to finish.

These settings work together with the ![](/icons/calendar-range.svg) Template's item-start rules and filler. An overrun allowance does not guarantee every item can start or that no gap will occur. Check the resolved handoff, not just the nominal times.

## Preview, save, and apply changes

Use **Preview date** and **Refresh Now** to inspect the actual lineup. Test a date where the condition matches, one where it does not, and any overlap with a higher layer. For time-limited layers, inspect the entry and exit times as well as the content inside the window. Review dead-air warnings and other issues before saving.

Hover over a guide block to see a zoomed timeline of its actual items, centered near the time under the pointer. Move along the block to inspect another time. Hover, focus, or tap a guide block to inspect the actual items within it; dead-air diagnostics continue to use actual playback times. Choose **Save** to store the schedule and return to the channel schedule list. If saving fails, the editor stays open with your changes; **Reset** discards pending changes after confirmation.

Saved changes normally become active at the next local midnight, protecting programming that has already been committed. When offered, **Apply after current item** brings a change forward without cutting the item viewers are currently watching.
