---
id: operations.status
title: Status and logs
description: Check system health and find useful diagnostic details.
contextual: true
---

# Status and logs

The dashboard is the first place to check when viewers report a problem. It summarizes playback readiness, active channels, library health, and data conflicts.

Select a program or template conflict to open the affected resource. If the conflict does not identify a specific resource, Moirai opens its catalog instead.

![The Moirai status dashboard](/screenshots/dashboard.png)

An active channel shows connected playback work and can be restarted from its action menu. Restarting interrupts the current stream, so use it only when viewers can tolerate a reconnect.

The **Logs** page presents retained structured server activity. Filter by level or search for the channel, library, request, or error involved. Open an entry for its timestamp and structured context.

![The logs page](/screenshots/logs.png)

Warnings often describe a recovered or degraded condition. Errors indicate work that did not finish. When asking for support, include the relevant message and time, but remove source paths, addresses, or other private values you do not want to share.
