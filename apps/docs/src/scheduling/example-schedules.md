---
id: scheduling.example-schedules
title: Example schedules
description: Create movie channels, genre double features, sitcom rotations, and cartoon lineups.
contextual: false
---

# Example schedules

These recipes show how to turn a viewing idea into Programs, a Template, and a Channel Schedule. examples include a movie channel, genre double features, a sitcom rotation, or a cartoon lineup. The cartoon recipes compare all four Sequence ordering modes using the same counts.

## A shuffled movie channel

Use this for an all-day movie channel that works through its collection before repeating. You need an available Movies library with several indexed movies. This recipe uses one Content Program.

1. Open **Scheduling → Programs** and create a **Content** Program named **Movie Shuffle**.
2. Select your Movies library and use **Specific media items** to choose the films you want. Alternatively, choose **Library query** and use **Configure Filters** to define a collection that updates with the library, such as movies with the Adventure genre.
3. Choose **Shuffle (no repeats)** under **Selection**, then save.
4. Create a Template named **Movie Day**. Assign **Movie Shuffle** to its initial midnight-to-midnight slot.
5. Keep the default scheduling settings. The shuffle pool carries across days, and films can finish across midnight.
6. Preview the Template and save. Create or select a movie Channel, assign **Movie Day** as its base Template in **Channel Schedules**, and save.

![Movie Shuffle Content Program with a selected film collection and Shuffle (no repeats)](/screenshots/example-movie-shuffle.png)

With four eligible films, one possible shuffle cycle is:

```text
Movie C → Movie A → Movie D → Movie B
```

The Content Program avoids repeating a film until everything available has been played. Note that this is a pool of films, not a daily quota: a cycle can span several days depending how many are selected.

## Genre double features

Use this for a channel that plays two movies from one genre, then two from another, while changing which order the genres play in each cycle. Prepare three or more collections with at least a few playable movies each.

1. Create three **Content** Programs named **Adventure Movies**, **Comedy Movies**, and **Science Fiction Movies**. For each, select your Movies library and choose **Specific media items** to curate its films. Use distinct collections if you want to prevent the same movie from belonging to several blocks.
2. Set each Program to **Shuffle (no repeats)** and save. This only controls which films are selected within that collection.
3. Create a **Sequence** named **Double Features**. Add the three Programs with a count of **2** for each one. Choose **Shuffled blocks**, enable **Repeat sequence**, and save.
4. Create a Template named **Double Feature Day** and assign **Double Features** to its initial all-day slot. Choose **Continue persistently** and retain **Allow overrun**, **Finish left item**, and **No Limit**.
5. Preview the Template and save it. Assign it as the movie Channel's base Template in **Channel Schedules**, save, and inspect the Guide.

![Double Features Sequence with two selections per genre and Shuffled blocks ordering](/screenshots/example-double-features.png)

One possible cycle is:

```text
Comedy A → Comedy B → Adventure A → Adventure B → Science Fiction A → Science Fiction B
```

Each cycle contains six movies, with each genre pair kept together when the films can play. The next cycle shuffles the genre steps again, selecting the next movies from each child Program's pool. Counts measure films rather than hours, so these blocks have no fixed duration and may cross into different days.

## A sitcom rotation with a featured show

Use this for a sitcom channel that gives one show twice as many selections as either of two others, while keeping every show's episodes in order. You need three shows, which will be **Corner Café**, **Flatmates**, and **Office Hours** for this example.

1. Create a **Content** Program for each show. Select your Shows library, choose **Specific media groups**, and select the corresponding show. Set **Selection** to **Sequential** and save each Program.
2. Create a **Sequence** named **Sitcom Rotation**. Add **Corner Café × 2**, **Flatmates × 1**, and **Office Hours × 1**, in that order.
3. Choose **Balanced rotation**, enable **Repeat sequence**, and save. This favors Corner Café by count while spreading the selections through each cycle.
4. Create a Template named **Sitcom Day**. Assign **Sitcom Rotation** to the initial all-day slot, select **Continue persistently**, and retain **Allow overrun**, **Finish left item**, and **No Limit**.
5. Preview and save the Template, then assign it to a sitcom Channel as the base Template in **Channel Schedules**. Save and check the Guide.

![Sitcom Rotation Sequence with 2/1/1 counts and Balanced rotation ordering](/screenshots/example-sitcom-rotation.png)

The first cycle is:

```text
Corner Café 1 → Flatmates 1 → Office Hours 1 → Corner Café 2
```

The next cycle avoids opening with Corner Café when another step is available. Each show advances through its own episodes, and a new sequence cycle does not restart its seasons. For two-episode sitcom blocks instead, change the counts to 2/2/2 and choose **Ordered** or **Shuffled blocks**.

## Kid-centric cartoon lineups

You need an available Shows library with episodes from three shows. For these examples, we'll call them **Acorn Adventures**, **Bumble Brigade**, and **Cloud Club**.

1. Open **Scheduling → Programs** and create a **Content** Program named **Acorn Adventures**.
2. Select your Shows library, choose **Specific media groups** as the source, and select the corresponding show in the media picker. Use **Sequential** selection so episodes advance in season and episode order. Save the Program.
3. Repeat for **Bumble Brigade** and **Cloud Club**, also using Sequential selection.
4. Create a **Sequence** Program named **Cartoon Lineup**. Add the three Programs as steps in that order, with counts **3**, **2**, and **1**.
5. Keep **Repeat sequence** checked. Choose one of the ordering recipes below, then save.

Each cycle contains six episode selections: three from Acorn, two from Bumble, and one from Cloud. To include ten shows, create seven more Content Programs and add one step for each, with its own count. The cycle total is the sum of all step counts.

![Sequence ordering choices and optional stable seed](/screenshots/program-sequence-ordering.png)

### Predictable cartoon blocks

Choose **Ordered**. The three Acorn selections play together, followed by the two Bumble selections, then Cloud. The next cycle starts with Acorn again.

Example first cycle, where the number is the episode selected from that show:

```text
Acorn 1 → Acorn 2 → Acorn 3 → Bumble 1 → Bumble 2 → Cloud 1
```

Use this for a predictable lineup of short show blocks. Follow **Put the lineup on a channel** below to schedule it.

### Shuffled cartoon mini-marathons

Choose **Shuffled blocks**. Each cycle shuffles the three steps while keeping each step's selections together.

One possible first cycle:

```text
Bumble 1 → Bumble 2 → Cloud 1 → Acorn 1 → Acorn 2 → Acorn 3
```

A later cycle can use a different step order. Each show continues from its own next episode. Shuffle can also happen to produce the same order again; it does not promise a different permutation every cycle.

### Mixed cartoon lineup

Choose **Shuffled allocations**. Selections from the three steps are mixed together while retaining the 3/2/1 allocation per cycle.

One possible first cycle:

```text
Acorn 1 → Bumble 1 → Acorn 2 → Cloud 1 → Bumble 2 → Acorn 3
```

Consecutive selections from the same step are allowed. Choose this mode when you want a random mix with exact counts, rather than a guaranteed gap between shows. The examples here illustrate possible output; they do not predict a particular seed's result.

### Balanced cartoon rotation

Choose **Balanced rotation**. The sequence spreads selections in proportion to the counts and avoids selecting the previous step when another step still has selections remaining. Ties follow the authored step order.

For the three steps above, the first cycle is:

```text
Acorn 1 → Bumble 1 → Acorn 2 → Cloud 1 → Bumble 2 → Acorn 3
```

The previous step is remembered across cycles, so the next cycle can start differently. If one step has more selections than the others can separate, consecutive selections eventually become unavoidable. Balance applies to steps: adding the same Program twice creates two independent steps, not one combined show quota.

### Put the lineup on a channel

1. Open **Scheduling → Templates** and choose **New Template**. Name it **Cartoon Day**.
2. Select the initial midnight-to-midnight slot and choose **Cartoon Lineup** as its **Program**.
3. Keep **Allow overrun** as the item start rule, with **Finish left item** and **No Limit** at the outgoing boundary, so an episode can finish. Actual transitions may occur after the nominal boundary.
4. Under **Advanced scheduling behavior**, choose **Continue persistently**. This carries both the sequence cycle and child episode progress into the next day. Choose **Restart each day** instead only if you want both to start over daily.
5. Check the resolved Template preview, then save. Confirm that episode selections follow the chosen mode and inspect any unavailable-source or gap warnings.
6. Create or select your cartoon Channel. In **Channel Schedules**, select that Channel and assign **Cartoon Day** as its base Template. Save and check the Guide.

![Template slots and resolved programming preview](/screenshots/template-editor.png)

![Playback state controls for continuing progress or restarting each day](/screenshots/template-slot-playback.png)

## Weekdays with a weekend variation

This recipe uses the mixed cartoon lineup throughout the day, with predictable cartoon blocks from 8:00 AM to noon on weekends.

1. Keep **Cartoon Lineup** in **Shuffled allocations** mode and keep **Cartoon Day** as the base Template from the previous recipe.
2. Create another Sequence named **Weekend Cartoon Blocks**. Reference the same three Content Programs with counts 3/2/1, choose **Ordered**, and enable **Repeat sequence**.
3. Create a Template named **Weekend Morning**. Split its initial slot at **8:00 AM**, then split the later slot at **12:00 PM**.
4. Set the first and last slots to **No program — fall through**. Assign **Weekend Cartoon Blocks** to the 8:00 AM slot. Leave the item start and boundary settings as **Allow overrun**, **Finish left item**, and **No Limit**.
5. Set the morning slot to **Continue persistently** and save the Template. Its episode progress is independent of the base lineup's progress.

![Weekend Morning Template with an 8 AM–noon cartoon block and fall-through slots before and after it](/screenshots/example-weekend-template.png)

The Template's standalone preview shows dead air outside the morning block. Those fall-through slots use **Cartoon Day** when this Template is layered into the Channel Schedule below.

6. In the Channel Schedule, add a conditional layer using **Weekend Morning**. Configure a **Weekdays** condition with **Sat** and **Sun** selected. Set the layer’s entry and exit **Boundary behavior** to **Finish outgoing item within drift**, with **No limit — always finish outgoing item**, then save.
7. Preview a weekday and a weekend date. Weekdays should use the base lineup throughout; weekend mornings should use the ordered blocks, with the base lineup supplying the other slots. Confirm the result in the Guide.

![Cartoon Channel schedule with Weekend Morning above Cartoon Day, Saturday and Sunday selected, and a resolved weekend preview](/screenshots/example-weekend-schedule.png)

The 8:00 AM and noon boundaries are nominal: finish-left rules allow an episode to finish before switching. For exact clock transitions, consult [Template boundary settings](/scheduling/templates) and review the effect of truncation before changing them.

For more detail, see [Programs](/scheduling/programs), [Templates](/scheduling/templates), and [Channel Schedules](/scheduling/channel-schedules).
