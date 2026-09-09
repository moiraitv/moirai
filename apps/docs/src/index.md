---
id: welcome
title: Welcome to Moirai
description: Understand what Moirai does and how its parts fit together.
contextual: true
---

# Welcome to Moirai

Moirai turns a collection of video files into on-demand, continuously available IPTV channels. You choose the media, describe how it should be arranged, and connect an IPTV application to the playlist and guide that Moirai publishes.

Moirai is a scheduling platform built on top of the [ErsatzTV Next playback engine](https://ersatztv.org/next-docs/). Moirai manages your libraries and decides what plays when; ErsatzTV Next handles converting the media for playback (transcoding) and streaming it to viewers.

Moirai builds a rolling schedule from reusable pieces:

- A **![](/icons/library.svg) Library** points to media that Moirai can scan.
- A **![](/icons/list-video.svg) Program** chooses eligible media and decides its order.
- A **![](/icons/calendar-range.svg) Template** places Programs into parts of a day.
- A **![](/icons/tv-minimal-play.svg) Channel Schedule** assigns Templates to a Channel.
- A **![](/icons/tv-minimal.svg) Channel** provides the number, name, streaming profile, and optional logo viewers see.

The quickest route through this guide is [Install with Docker](/getting-started/docker), then [Create your first channel](/getting-started/first-channel).

For help while using Moirai, select the question-mark button beside a page title to open instructions for that page. The **User Guide** link at the bottom of the sidebar opens this complete guide in a new tab.
