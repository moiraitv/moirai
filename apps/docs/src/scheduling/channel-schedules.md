---
id: scheduling.channel-schedules
title: Channel schedules
description: Assign a base template and conditional layers to a channel.
contextual: true
---

# Channel schedules

A channel schedule chooses which templates apply to one channel. Start with a base template, then add
conditional layers only when particular dates or circumstances need different programming.

![The channel schedule catalog](/screenshots/channel-schedules.png)

Layers are evaluated in their displayed order. A matching layer can replace or supplement the base
structure according to its configuration. Keep conditions narrow and use descriptive names so future
operators can understand why a date differs.

Preview the resolved schedule before saving. The preview reports the actual timeline and warnings but
does not advance the saved selection state.

Saved changes normally become active at the next local midnight, protecting programming that has
already been committed. When offered, **Apply after current item** brings a change forward without
cutting the item viewers are currently watching.
