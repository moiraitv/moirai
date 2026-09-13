---
id: playback.encoding-profiles
title: Encoding profiles
description: Reuse audio and video settings across channels while keeping Custom settings independent.
contextual: true
---

# Encoding profiles

Open **Playback → Encoding profiles** to manage reusable audio and video settings. **Credit templates** also live under Playback; scheduling pages continue to control what plays and when.

Expand **Used by** in a saved profile to see channels explicitly linked to it. Open a channel from that list to inspect its settings.

## Create a profile

Choose **New profile**, give it a distinct name, and configure its video and audio settings. A profile includes resolution, codecs, bitrates and buffers, scaling, bit depth, hardware acceleration, deinterlacing, audio channels, sample rate, and loudness normalization. **Automatic** hardware acceleration lets Moirai select a supported backend for each channel. When viewing or editing a profile, the Acceleration field shows a prediction using the server’s default FFmpeg.

![Encoding profile editor showing reusable video and audio settings](/screenshots/encoding-profile-editor.png)

Choose **Save** to store the profile. **Duplicate** starts an independent copy. **Reset** requires a second confirmation before restoring the opening draft. Closing an edited profile asks whether to save or discard your changes.

## Use a profile on a channel

Edit a [Channel](/scheduling/channels) and choose the profile under **Encoding profile → Audio and video settings**. The inherited settings remain visible but cannot be edited on that channel. Save the channel to apply the assignment.

Changes saved to a profile apply to every linked channel, using the same playback refresh as editing a channel directly. Active sessions are marked stale when encoding settings change. Use the restart action on Status when you are ready to interrupt viewers. Already buffered video is unchanged.

Profiles only own audio and video settings. Channel numbers, names, logos, groups, schedules, fallback media, subtitle selection and mode, credit templates, fonts, FFmpeg paths, and filter preferences remain channel-specific.

## Keep channel-specific settings

Choose **Custom** to edit audio and video settings independently. Upgrades preserve each existing channel’s profile assignment or Custom settings.

Switching from a profile to **Custom** automatically copies its audio and video values as the starting point for manual changes. Save to keep that choice. Later profile changes no longer affect the channel. To start a Custom configuration from another profile, select that profile first, then choose **Custom**.

## Delete a profile

Open the profile and choose **Delete Encoding Profile**, then confirm in the dialog. Built-in presets cannot be deleted. A custom profile cannot be deleted while selected as the default or used by any channel. Change those channels to another profile or Custom and save them first.

## Built-in presets and the default

![Built-in encoding presets with 1080p selected as the default for new channels](/screenshots/encoding-presets.png)

Moirai includes non-deletable, read-only presets for 480p, 576p, 720p, 1080p, 1440p, and 4K. Choose **View** to inspect one or **Duplicate** to make an editable custom copy. The view also has a **Duplicate** button at the bottom. Video and audio fields keep their labels inside the field borders. The cards show a description, a **Built-in** badge, and a **Default** badge for the selected default. Duplicating a profile also copies its description. Each uses progressive, square-pixel 16:9 video, H.264 with 8-bit color, AAC stereo at 192 kbps, scaling with padding, and automatic hardware acceleration. These are starting configurations; duplicate one to tune its bitrate or codec for your content and server.

![Read-only encoding profile with video and audio sections and a Duplicate action](/screenshots/encoding-profile-view.png)

| Preset | Resolution  | Video bitrate |
| ------ | ----------- | ------------- |
| 480p   | 854 × 480   | 1,500 kbps    |
| 576p   | 1024 × 576  | 2,000 kbps    |
| 720p   | 1280 × 720  | 4,000 kbps    |
| 1080p  | 1920 × 1080 | 8,000 kbps    |
| 1440p  | 2560 × 1440 | 16,000 kbps   |
| 4K     | 3840 × 2160 | 32,000 kbps   |

**1080p** is the initial default. Choose any preset or custom profile under **Default for new channels** to change it. This selection applies to the new-channel editor and Quick Setup; it never reassigns existing channels. Choose Custom in the channel editor to opt out. A custom profile selected as the default cannot be deleted until you choose another default.
