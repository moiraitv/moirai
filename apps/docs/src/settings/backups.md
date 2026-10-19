---
id: settings.backups
title: Backup settings
description: Configure automatic backups and create, import, download, restore, or delete configuration archives.
contextual: true
---

# Backup settings

Open **Settings → Backups** to manage automatic backup policy and saved archives.

![Backup and restore settings](/screenshots/backup-settings.png)

## Backup & Restore {#backup-and-restore}

Backups preserve configuration, the library index and IDs, channel icons, custom guide artwork, and custom fallback videos. They exclude library media files, generated thumbnails and other caches, logs, passwords, sessions, and API keys. 

For simple restoration, reep media mounted at the same paths when moving to another installation. You can adjust library paths and re-scan to adapt to a new mount point without losing any configuration, though.

Backup filenames are dated to include their creation time in UTC (`Z`) and a unique ID (e.g., `moirai-2026-10-17T21-15-30.123Z-<id>.zip`).

## Automatic Backup {#automatic-backup}

Automatic backups are enabled by default, run every **1 day** at **3:00 am** in Moirai’s configured time zone, and retain the most recent **7** automatic backups. Expand **Automatic Backup** to change **Backup interval (days)** or **Automatic backups to retain**. If Moirai is offline at the scheduled time, it waits for the next scheduled run rather than creating catch-up backups.

The automatic backup section shows the saved policy summary. You can expand **Automatic Backup** to view the schedule, next run, and storage location in more detail.

Additional automatic backups are created on upgrading Moirai or before restoring from a backup.

Saved backups appear in the table under **Backups**. Backups can use a [separate Docker volume or bind mount](/getting-started/docker#backup-storage).

## Backups {#backups}

On the **Backups** tab, there are several actions available:

- Use **Create Backup** to save a manual backup snapshot right now.
- Click **Download** beside a saved backup to export it. 
- **Import Backup** uploads a backup ZIP for validation and prompts to restore it.
- To restore from a saved backup, choose **Restore** and then confirm.

### Review and restore

![Reviewing a validated backup before replacement](/screenshots/backup-restore.png)

Review the filename, creation time, backup type, application version, size, and library, media item, and channel counts. Choose **Restore and Restart** only when you are ready to replace the current configuration. **Cancel Restore** closes the review without replacing anything. If validation fails, use the displayed reason and request ID to check the server logs.

Restoring replaces the saved configuration and briefly stops playback while Moirai restarts. Once restore preparation succeeds, Moirai completes the restart.

Your current administrator account is preserved, but existing sessions are invalidated and you must sign in again. Validation failures leave the current configuration untouched. If an interrupted restore cannot finish, check storage permissions and free space, then restart Moirai to resume it.

### Retention and deletion

Manual backups stay until you delete them. Restoring first creates a **Pre-restore recovery** backup, which also stays until deleted. Upgrades attempt a recovery backup before any database updates; only the newest **3 Upgrade recovery** backups are kept. These limits are independent of automatic backup retention. Choose **Delete** beside a backup, review its name in the confirmation dialog, then choose **Delete Backup** to remove it permanently. Choose **Keep Backup** or press Escape to cancel. Unreadable archives appear with a warning and can still be deleted; healthy backups remain available.
