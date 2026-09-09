---
id: glossary
title: Glossary and terminology
description: Understand the building blocks of a channel and the terms used throughout Moirai.
contextual: false
---

# Glossary and terminology

## How the pieces fit together

Think of Moirai as running your own television station. A **![](/icons/library.svg) Library** supplies the videos, a **![](/icons/list-video.svg) Program** chooses what to play, a **![](/icons/calendar-range.svg) Template** gives the day its structure, and a **![](/icons/tv-minimal-play.svg) Channel Schedule** chooses which Template applies. The **![](/icons/tv-minimal.svg) Channel** is what viewers tune into, and the **![](/icons/calendar-days.svg) Guide** shows the resulting lineup.

| Building block | The question it answers | Example |
| --- | --- | --- |
| ![](/icons/library.svg) Library | Where does the media come from? | Your Movies folder. |
| ![](/icons/list-video.svg) Program | What should play, and in what order? | Shuffle the adventure movies. |
| ![](/icons/calendar-range.svg) Template | How should a typical day be arranged? | Family films in the morning, adventures in the evening. |
| ![](/icons/tv-minimal-play.svg) Channel Schedule | Which daily arrangement applies? | Use the regular Template by default and a specific one on holidays. |
| ![](/icons/tv-minimal.svg) Channel | What do viewers tune into? | Channel 7.1, Evening Cinema. |
| ![](/icons/calendar-days.svg) Guide | What is actually scheduled to play? | Cinder Atlas at 8:00 pm, followed by the next selected film. |

You can start quickly by creating these linked pieces together with [Quick Setup](/getting-started/first-channel), or you can create each manually for more control.

## Channel-building terms

### ![](/icons/library.svg) Library

A media source, such as a folder of movies, and the searchable catalog Moirai builds from it. Scanning reads the files and their details so Moirai can find and schedule them.

Adding a library does not, by itself, put its contents on a channel. See ![](/icons/library.svg) [Libraries and scanning](/libraries/managing-libraries).

### Media Item

One playable video, such as a movie, television episode, or music video. A show or season groups episodes; it is not itself a single video.

### ![](/icons/list-video.svg) Program

A reusable instruction for choosing media and deciding its playback order. For example, an “Adventure Movies” Program might select movies with the `Adventure` genre and shuffle them.

In Moirai, **![](/icons/list-video.svg) Program** means this reusable setup. It does not necessarily mean one television show or one entry in the guide. A Program can supply many videos and be reused in several Templates. See ![](/icons/list-video.svg) [Programs](/scheduling/programs).

### ![](/icons/calendar-range.svg) Template

A reusable plan for a day, made of time slots that use ![](/icons/list-video.svg) Programs. For example, a Template could start family films at 8:00 am and adventure movies at 6:00 pm. A Template describes the day's structure; Moirai selects the individual videos when it works out the lineup.

Reuse a Template across days or ![](/icons/tv-minimal.svg) Channels instead of rebuilding the same plan each time. See ![](/icons/calendar-range.svg) [Templates](/scheduling/templates).

### Slots and Boundaries

A **Slot** is a part of a Template with a start time and a Program. A **Boundary** controls the transition between slots. Because a movie may run past the next slot's start time, the boundary decides whether to let it finish or cut at the planned transition, according to your settings.

### Schedule / Channel Schedule

The rules assigning daily Templates to one ![](/icons/tv-minimal.svg) Channel. The **base Template** is the default daily plan. **Layers** add conditional changes for particular dates or circumstances.

“Schedule” can also mean the resulting list of videos and times. The Channel Schedules editor is where you configure the rules; its preview and the ![](/icons/calendar-days.svg) Guide show the lineup those rules produce. See ![](/icons/tv-minimal-play.svg) [Channel schedules](/scheduling/channel-schedules).

### ![](/icons/tv-minimal.svg) Channel

The named, numbered stream that viewers select in their IPTV application. It has a schedule and playback settings, plus an optional logo. The channel brings the programming together into something people can watch. See ![](/icons/tv-minimal.svg) [Channels](/scheduling/channels).

### Preview and committed guide

A **preview** shows a possible lineup so you can inspect your choices before saving. It can differ from the **committed guide**, which is the lineup Moirai has accepted for delivery. An unsaved preview does not change what viewers receive.

## Media selection and playback

**Library Query** — Rules for selecting matching media from a library, such as genre or release year. The matching set can change as the library changes. An explicit selection instead names particular items you chose.

**Selection Strategy** — How a program chooses from its eligible media. Sequential follows an order; shuffle works through a shuffled pool; random makes a fresh random choice at each step; weighted random prioritizes selection based on which media is most-watched.

**Filler** — Media used to occupy spare time in a planned schedule, such as short videos between longer features.

**Fallback** — The backup video used when the schedule leaves a playback gap. It keeps the stream running but does not repair the scheduling issue. A channel-specific choice can override the global fallback; a bundled fallback is also available.

**Dead air / gap** — Time with no scheduled primary media. Moirai uses fallback during playback to cover it. Recurring gaps are a reason to inspect the program, template, and preview warnings.

**Transcoding / normalization** — Converting source videos into a consistent streaming format that your player can handle.

## Connecting a player and managing media

**IPTV client** — The application or device you use to watch the channels over your network.

**M3U playlist** — The channel list you give your IPTV client. It tells the client which channels exist and where to stream them.

**EPG / XMLTV** — The electronic program guide and its data format. The guide tells your IPTV client what is playing and what comes next. See ![](/icons/calendar-days.svg) [Guide and IPTV clients](/playback/guide-and-clients).

**Public URL** — The address Moirai publishes in its connection information. It must be reachable from the device watching the channels; the word “public” does not require exposing Moirai to the internet, just that it's visible outside of the system running it (e.g., so your TV box can see it over the network).

**NFO / sidecar** — A companion text file beside a video, commonly produced for Kodi and similar, containing its title, plot, genres, credits, and other details.

**Scan / index** — A scan examines the media source. The index is the catalog of information Moirai keeps afterward for browsing and scheduling.

**Reconciliation** — Reviewing missing or changed media so Moirai's catalog agrees with the source files. See [Missing media and conflicts](/libraries/reconciliation).
