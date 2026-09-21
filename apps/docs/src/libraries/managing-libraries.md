---
id: libraries.manage
title: Libraries and scanning
description: Add media sources and understand what happens during a scan.
contextual: true
---

# ![](/icons/library.svg) Libraries and scanning

Choose **Add Library** to open the library editor. Enter the source details, then choose **Add and Scan**. **Reset** discards the draft after confirmation; closing the editor also protects unsaved changes.

![Add Library editor](/screenshots/library-create.png)

A ![](/icons/library.svg) Library tells Moirai where media lives. Open **![](/icons/library.svg) Libraries** to add a source, see its current health, or start a synchronization.

![The libraries page before a source is added](/screenshots/libraries.png)

Use the path as Moirai sees it. In Docker this is normally a mounted path such as `/media/movies`. Moirai reads video files and Kodi-compatible NFO sidecars, probes technical playback facts, and keeps an index in its database. The original media remains the source of truth.

See [Media file naming](/libraries/media-file-naming) for recommended movie and show layouts, episode numbering, editions, multi-part videos, artwork, NFO files, and subtitle names.

Direct streaming from media center software such as Jellyfin, Plex, Emby, and similar services is not currently supported. Make the underlying media files available to Moirai through a filesystem path instead, such as a folder mounted into its Docker container.

Each library in the main navigation has a scan-status indicator on its right. Hover over it to read its status label.

| Icon | Status | Meaning |
| --- | --- | --- |
| ![Green dot](/icons/scan-idle.svg) | Idle | No scan is running, and no scan warnings or offline sources are reported. |
| ![Spinning arrows](/icons/scan-scanning.svg) | Scanning | A scan is running. The arrows spin unless reduced motion is enabled. |
| ![Orange unplug](/icons/scan-offline.svg) | Offline | A library source is offline. |
| ![Orange circled exclamation mark](/icons/scan-warnings.svg) | Warnings | The last scan reported warnings. Open **Last scan** to review them. |
| ![Gray dash](/icons/scan-not-scanned.svg) | Not scanned | The library has not completed its first scan. |

Scanning takes priority while a scan is running; otherwise, Offline takes priority over Warnings.

The first scan can take time for a large collection. A source watcher handles ordinary additions and changes afterward. Use ![Sync library](/icons/refresh-cw.svg) when you want an immediate full scan. After scanning, the catalog displays the indexed media with its posters and titles.

![Evening Cinema library with 17 indexed movies, poster artwork, and scan status](/screenshots/library-catalog.png)

At the top of the library screen you can see watcher health, the indexed count, scan history, and its most recent change. A scan may finish with warnings even when most media was indexed successfully. Click or tap **Last scan** at the top of the library to open **Scan history**, including scan results, item counts, and recorded issues. Review those issues before changing a schedule that depends on missing items.

![Scan history dialog with completed scan results](/screenshots/library-scan-history.png)

Library settings can change the display name or source path. A path change is staged for safety when it could make many existing items appear to have disappeared.

## Library health

When a library scan finds issues, it will display a small alert at the top of the page. Open **Review Issues** on a library to see findings from that scan. **Last scan** opens the history of earlier results. Each finding includes a code and, when applicable, the affected path.

Note that a warning does not necessarily mean the media cannot play. Choose **Ignore issue** to hide it from attention counts until its relevant files change. Ignoring does not repair media, make it playable, resolve catalog conflicts, or approve source changes or removals. Folder/source availability, scan-wide failures, and reconciliation decisions cannot be ignored.

Open **Show all issues → Suppressed issues** to review automatically suppressed and manually ignored findings. You can also reach **Suppressed issues** from **Last scan**. Choose **Restore issue** on a manually ignored finding to return it to attention counts; a later scan may still suppress a duration finding automatically.

After correcting a file, its metadata, or source access, synchronize the library to refresh its health. Use the finding code below to identify the problem and available remedies.

### Audio/video duration differences

`media_audio_video_duration_mismatch` means at least one measured audio track differs from the video duration by more than thirty seconds. Playback and scheduling use the video duration, but audio tracks that differ in length significantly from the main video duration can be a sign of incomplete media. Check the reported tracks and watch the affected ending before deciding whether the difference is harmless or the file needs replacing.

Moirai automatically suppresses the finding when every measured audio track is no more than 5% shorter than the video and none is more than thirty seconds longer.

For larger differences, Moirai checks short silent endings during library scans when all audio tracks finish before the video and within thirty seconds of one another. Inspection starts at the earliest audio ending and continues to the end of the video. Endings that remain at least 90% black throughout the inspected frames are automatically suppressed. This includes most white-on-black credit sequences. Endings that do not meet that threshold, incomplete inspection, and uncertain results remain warnings.

### Missing NFO metadata

`nfo_missing` means no matching NFO sidecar was found. Moirai uses the filename for metadata instead. Add a Kodi-compatible NFO if you want richer or more accurate details, using the layouts in [Media file naming](/libraries/media-file-naming), then synchronize the library.

### Invalid NFO metadata

`nfo_invalid` means the media item's NFO could not be read or parsed. Check the reported file's permissions and XML contents, or regenerate it with your media manager, then synchronize the library.

### Invalid show metadata

`tvshow_nfo_invalid` means show-level NFO metadata could not be read or parsed. Check the reported show metadata file, repair its contents or permissions, and synchronize the library.

### NFO file too large

`nfo_too_large` means an NFO exceeds the 2 MiB reading limit. Reduce or regenerate the sidecar so it contains only the needed metadata, then synchronize the library.

### Metadata shortened

`metadata_truncated` means some metadata exceeded Moirai's supported length or list limits. The finding names the affected fields. Shorten those fields or reduce oversized lists in the NFO, then synchronize the library. Other usable metadata can still be indexed.

### Invalid metadata values

`metadata_invalid` means individual metadata values were ignored because they were invalid. Correct the fields named in the finding and synchronize the library; this finding does not mean the entire NFO was rejected.

### Conflicting show identifiers

`show_external_id_conflict` means multiple show folders share an external provider identifier. Moirai keeps the folders separate. Check their NFO identifiers and folder layout, correct accidental duplicates, and synchronize the library. See [Missing media and conflicts](/libraries/reconciliation).

### Folder cannot be read

`directory_unreadable` means Moirai could not list a folder's contents. Restore the mount or folder permissions and scan again. The scan is incomplete, so do not assume unlisted files were deliberately removed.

### Media file cannot be read

`media_unreadable` means a file could not be accessed while scanning. Check its permissions, storage connection, and the finding's message, then scan again once access is restored.

### Media changed during scanning

`media_changed_during_scan` means a file disappeared, was replaced, or changed while Moirai was examining it. Let copies, downloads, or file moves finish, then synchronize again.

### Media inspection unavailable

`media_executable_unavailable` means Moirai could not use ffprobe to measure media. Check the server installation and ffprobe availability, then restart the server if needed and synchronize the library. Filename or NFO runtimes cannot substitute for a measured video duration.

### Insufficient resources for media inspection

`media_resource_exhausted` means the server could not start media inspection because system resources were exhausted. Reduce competing work or resolve the host's resource limits, then scan again. The finding may describe a library-wide problem rather than one damaged file.

### Media inspection failed

`media_probe_failed` means ffprobe could not read the media successfully. Check that the file is complete and accessible, and verify it in a media player. Repair or replace a damaged file, or restore source access, before scanning again.

### Invalid media inspection result

`media_invalid_output` means ffprobe returned unusable information or exceeded the supported output size. Check the file and server's ffprobe installation. If the file plays correctly but the finding persists after another scan, retain the finding details for troubleshooting.

### Media inspection timed out

`media_timed_out` means inspecting a file exceeded the time limit. Check for slow or disconnected storage and heavy server load, then scan again. If the same file repeatedly fails, check whether it is damaged or incomplete.

### Media inspection cancelled

`media_cancelled` means inspection stopped before the file could be measured. Run another scan when the server is ready. This finding alone does not establish that the file is damaged.

### No usable video track

`media_missing_video` means Moirai found no usable video stream; embedded cover artwork does not count as video. Check that the file is the intended video rather than an audio-only file or a damaged export, then replace or re-export it as needed.

### No usable video duration

`media_missing_duration` means Moirai could not obtain a valid duration from the video tracks. The item cannot be scheduled using an NFO or container runtime instead. Check the media file and repair or re-export it with valid video timing, then synchronize the library.

### Incomplete multipart video

`multipart_incomplete` means a multipart title lacks a contiguous sequence beginning with part 1, or only one numbered part was found. Restore missing parts or correct their names using [Media file naming](/libraries/media-file-naming), then synchronize the library.

### Ambiguous multipart video

`multipart_ambiguous` means part numbers are duplicated or the title exceeds the 128-part limit. Correct duplicate numbering or reorganize the files into a supported layout, then synchronize the library.

### Invalid multipart duration

`multipart_duration_invalid` means a complete multipart set has a missing measured duration or a total beyond the 366-day scheduling limit. Check each part's inspection findings and make sure unrelated files were not grouped together, then correct the files or names and synchronize again.

### Source path change needs approval

`source_change_requires_approval` means a proposed library source change was inspected without replacing the existing index. Review the candidate source and its proposed changes. Approve it only if it is the intended replacement; otherwise correct the source settings. See [Missing media and conflicts](/libraries/reconciliation).

### Source identity change needs approval

`source_identity_requires_approval` means the source no longer appears to be the same directory or storage location Moirai previously accepted. Check for an incorrect mount or replacement disk before approving the source. Restore the original source if the change was unintended.

### Candidate source scan incomplete

`source_candidate_incomplete` means Moirai could not finish inspecting a proposed replacement source, so it was not imported. Restore access to all affected folders and files, then scan again before reviewing the replacement.

### Source changed during scanning

`source_identity_changed_during_scan` means the source root changed while the scan was running. Moirai does not use that scan to confirm removals. Stabilize the source mount or directory and run another scan.

### Missing items awaiting confirmation

`removal_confirmation_pending` means indexed items were not found and are awaiting three healthy observations at least thirty minutes apart before removal is confirmed. Restore any files that should still exist and check mounts and permissions. Repeated immediate scans do not bypass the waiting interval. See [Missing media and conflicts](/libraries/reconciliation).

### Missing items need removal approval

`removal_approval_required` means a substantial catalog change needs explicit review. Check that the source is correct and accessible before approving removal of indexed records. If the files should still exist, restore access instead of approving their removal. Follow [Missing media and conflicts](/libraries/reconciliation).

### Scan interrupted

`scan_interrupted` means a scan was still marked as running when the server recovered it after an interruption. Run a new scan to obtain a complete result.

### Scan failed

`scan_failed` means the scan could not finish. Read its message, check source access and server health, and scan again after resolving the cause. An inaccessible source does not mean the indexed files were intentionally deleted.

### Scan cancelled

`scan_cancelled` records that a scan was cancelled before completion. Start another synchronization when you want a complete inventory; cancellation alone does not indicate damaged media.
