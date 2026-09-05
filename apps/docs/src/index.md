---
id: welcome
title: Welcome to Moirai
description: Understand what Moirai does and how its parts fit together.
contextual: true
---

# Welcome to Moirai

Moirai turns a collection of video files into continuously playing IPTV channels. You choose the
media, describe how it should be arranged, and connect an IPTV application to the playlist and guide
that Moirai publishes.

You do not need to prepare a separate video file for every day. Moirai builds a rolling schedule from
reusable pieces:

1. A **library** points to media that Moirai can scan.
2. A **program** chooses eligible media and decides its order.
3. A **template** places programs into parts of a day.
4. A **channel schedule** assigns templates to a channel.
5. A **channel** provides the number, name, streaming profile, and optional logo viewers see.

The quickest route through the guide is [Install with Docker](/getting-started/docker), then
[Create your first channel](/getting-started/first-channel).

Moirai is an administrative service. Anyone who can sign in can change libraries, schedules, and
playback settings, so expose the management interface only to people you trust.
