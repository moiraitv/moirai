---
id: libraries.reconciliation
title: Missing media and conflicts
description: Safely resolve files that disappear or move between scans.
contextual: true
---

# Missing media and conflicts

Moirai does not immediately delete indexed media when a scan suddenly loses a meaningful part of a
library. The missing records enter reconciliation so an accidental unmount or incorrect path does
not silently damage schedules.

Check the source mount and permissions first. If the files are still meant to exist, restore access
and scan again. Moirai can then heal path-only moves or confirm that the original records remain.

If the files were deliberately removed, open the reconciliation review and confirm the proposed
removals. This is permanent for the indexed records, although scanning the files again can recreate
them.

The dashboard also reports data conflicts such as ambiguous identities. Resolve the source metadata
or folder layout, then synchronize the affected library. Existing committed guide entries can remain
playable from their captured metadata while new scheduling avoids unavailable content.
