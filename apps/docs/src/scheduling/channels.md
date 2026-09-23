---
id: channels.manage
title: Channels
description: Configure the identity and playback profile viewers receive.
contextual: true
---

# ![](/icons/tv-minimal.svg) Channels

To build a channel and its linked programming in one workflow, use [Quick Setup](/getting-started/first-channel). Return to the full editors for later adjustments.

A ![](/icons/tv-minimal.svg) Channel combines a viewer-facing number and name with playback settings. Open **![](/icons/tv-minimal.svg) Channels** to create or edit one and to review its resolved seven-day timeline.

Each row shows the channel number centered below its logo, or a TV icon when no logo is set. The timeline shows six hours at a time; scroll horizontally to see later programming.

To rebuild one channel’s programming from scratch, click its **Regenerate schedule** button, then confirm **Regenerate Schedule** in the dialog. This clears the channel’s generated timeline, selection progress, and scheduling history while keeping its saved templates and settings. Random and shuffled programs use fresh randomness unless you set an explicit seed; explicitly seeded programs restart from that seed, and ordered programs start over. Active playback restarts and may be interrupted.

Hover over an individual media item, or focus it with the keyboard, to preview its details. Click it for full guide details.

![The channels page](/screenshots/channels.png)

## Open the Channel editor

Choose **New Channel**, or tap anywhere in an existing channel’s left column, including its logo, number, name, or chevron. Warning badges still open their warning details. The editor controls its identity and the video/audio format delivered to viewers.

![Channel Broadcast profile editor showing the Lineup configuration](/screenshots/channel-editor.png)

Use the **On/Off** switch beside the close button to control whether the channel is published. Switch it **Off** and choose **Save** to remove the channel from the M3U playlist and its channel entry and programming from XMLTV. Its settings and schedule stay available in Moirai. Switch it **On** and save to publish it again. New and existing channels are on by default.

After a successful save, the channel appears in the lineup immediately while its schedule and guide refresh in the background. Any selected logo or fallback video finishes uploading before the editor closes.

If a logo or fallback upload fails after the channel is saved, the error identifies the unfinished asset. Your remaining draft stays open, and retrying Save updates the same channel.

## Lineup: identity and schedule

- **Number** identifies the ![](/icons/tv-minimal.svg) Channel in the lineup. As you type, the editor shows up to three existing channels matching the number prefix and flags a number already in use. Numbers must be distinct; choose stable values because IPTV applications may use them when organizing favorites.
- **Name** is the viewer-facing name.
- **Group** provides a category for the lineup, such as “Movies.” Choose a suggested existing group as you type, or enter a new one. How groups appear depends on the IPTV client.
- **Manage Layered Schedule** opens the ![](/icons/tv-minimal-play.svg) [Channel Schedule](/scheduling/channel-schedules), where you assign ![](/icons/calendar-range.svg) Templates and conditions. Save a new or changed ![](/icons/tv-minimal.svg) Channel first; the schedule link is disabled while the profile has pending changes.

### Channel logo

![Channel logo image picker](/screenshots/channel-editor-logo.png)

A logo is optional. Choose **Choose Image** to select a local image, then adjust the crop before saving. The editor accepts browser-supported images such as JPEG, PNG, and WebP, up to the displayed source-size limit. Uploaded logos are saved as PNG; the editor shows the output size limit, and cropping does not upscale the source image.

Remove an existing logo with its remove button and confirm the action, then save the profile. Choosing or removing an image is a draft change until **Save**.

### Channel fallback override

![Channel fallback video controls showing the effective source and upload action](/screenshots/channel-editor-fallback.png)

**Channel fallback override** lets this ![](/icons/tv-minimal.svg) Channel use its own fallback video instead of the effective global fallback. The panel shows the current source, file details, and a preview. Choose **Choose Video** (or **Choose Another**) to select a supported video up to 512 MiB; its video and audio are checked when saved. Silence is synthesized if the video has no audio.

Removing the override and saving returns this ![](/icons/tv-minimal.svg) Channel to the effective global fallback, which may be a global custom video or Moirai's bundled fallback. This is different from selecting a filler ![](/icons/list-video.svg) Program in a ![](/icons/calendar-range.svg) Template or ![](/icons/tv-minimal-play.svg) Channel Schedule: those rules schedule library media, while this setting supplies the playback fallback video. It does not remove ![](/icons/calendar-days.svg) Guide warnings; fix recurring scheduling gaps where possible.

## Audio and video encoding settings

New channels start with the saved default encoding profile (initially 1080p). Choose an [encoding profile](/playback/encoding-profiles) under **Encoding profile** to select a preset or to apply custom settings to the channel. 

Named profiles display the audio and video encoding settings that will apply, and updating a profile updates every linked channel.

Choose **Custom** for channel-specific settings. Switching from a profile to **Custom** copies its audio and video values as your starting point and detaches the channel when saved.

Active sessions with changed encoding settings are marked stale; restart them from Status when you are ready.

![Expanded encoding settings with summary badges and video and audio sections](/screenshots/channel-editor-encoding.png)

## Video normalization

![Video normalization controls for format, resolution, bitrate, scaling, acceleration, and deinterlacing](/screenshots/channel-editor-video.png)

These settings are available either by using `Custom` for the channel or with a shared [encoding profile](/playback/encoding-profiles).

Normalization gives the ![](/icons/tv-minimal.svg) Channel a consistent output format even when its source files differ. Start with the defaults and change settings to match your clients and server capacity.

- **Format:** choose H.264 or HEVC. Confirm that your playback clients support the selected format.
- **Width** and **Height:** set the output resolution. Larger output can require more processing and bandwidth.
- **Bitrate kbps:** controls the target video bitrate. **Buffer kbps** configures the encoder's rate-control buffer; it is not the client's playback buffer or the size of the transcode folder.
- **Bit depth:** sets the output color precision. The selected codec, encoder, and clients must support it.
- **Scaling:** **Scale and pad** preserves proportions and adds borders where needed; **Stretch** fills the frame by changing proportions; **Crop** fills it by removing edges.
- **Acceleration:** **Automatic** lets Moirai choose a supported path; the editor may show its predicted choice. **None** disables hardware acceleration. Explicit options such as VAAPI, QSV, CUDA, AMF, RKMPP, VideoToolbox, and Vulkan require a compatible host and playback engine. In Docker, the necessary devices and permissions must also be passed through; see [Install with Docker](/getting-started/docker).
- **Deinterlace:** enables processing for interlaced sources. Leave it off unless your source material requires it.

An acceleration option appearing in the menu does not mean this machine supports it. Test live playback after changing codec, bit depth, resolution, or acceleration, and check logs if the stream fails.

## Audio normalization

![Audio normalization controls for codec, bitrate, channels, sample rate, buffers, and loudness](/screenshots/channel-editor-audio.png)

These settings are available either by using `Custom` for the channel or with a shared [encoding profile](/playback/encoding-profiles).

- **Format:** choose AAC or AC3 to suit the playback clients.
- **Bitrate kbps:** sets the target audio bitrate.
- **Channels:** sets the output audio channel count—for example, 2 for stereo. This is not the number of IPTV ![](/icons/tv-minimal.svg) Channels.
- **Sample rate:** sets the audio sampling frequency in hertz, such as 48000.
- **Buffer kbps:** sets the audio encoder’s rate-control buffer.
- **Normalize loudness:** enables loudness normalization to reduce volume differences between source items. Set the integrated loudness target (LUFS), loudness range (LU), and true peak limit (dBTP) when enabled.

## Audio selection

![Channel audio selection with optional language and track-title preferences](/screenshots/channel-editor-audio-selection.png)

Use **Audio selection** to prefer an audio language or track title. Both fields are optional; leave them blank to keep automatic audio selection.

- **Preferred language code:** enter two or three letters, such as `en` or `eng`. Equivalent language codes match the same language.
- **Preferred audio title:** enter part of the audio track's title, such as `Original` or `Commentary`. Matching ignores case and does not use regular expressions.

Moirai first prefers the requested language, then a matching title within those tracks. If either preference has no matches, it keeps the remaining available tracks. It then prefers a track marked default, followed by the track with the most audio channels, and finally the lowest stream index. These are preferences: an unavailable language does not silence the video. With neither preference set, the playback engine keeps its normal selection.

[Programs](/scheduling/programs) can override either field, including within nested sequences. Audio settings apply separately to each file of a multipart video. Channel fallback override files keep their existing audio behavior. Changes take effect as the playback engine consumes updated scheduled items; the current item is not restarted.

Channel counts are collected during library scans. Missing or unusable stream metadata leaves selection to the playback engine.

## Subtitles

![Subtitle selection and additional subtitle settings](/screenshots/channel-editor-subtitles.png)

Subtitles and music video credits are optional and start Off. They're for different purposes but share settings and presentation.

Subtitles come from embedded or sidecar subtitle data. Moirai uses subtitle tracks discovered during library scanning; see [subtitle sidecar naming](/libraries/media-file-naming) if matching files are not appearing in the media details.

Music video credits use metadata about the content itself to generate and render opening and closing classic music video style credits. They're intended for content like music videos where movie/show-style subtitles are not used.

### Subtitle selection

Choose how Moirai selects an ordinary subtitle track for each video:

- **Off:** do not select ordinary subtitles. Music video credits can still be enabled separately.
- **Forced only:** select a matching track marked **forced**. These tracks commonly translate foreign-language dialogue or signs rather than every spoken line. The track must carry the forced flag; Moirai does not infer it from the dialogue. If no matching forced track exists, the video plays without ordinary subtitles.
- **Prefer default:** prefer a matching track marked **default**. If none is marked default, select another matching track. This is useful when your files already identify the subtitle track you normally want.
- **Any matching track:** select an available track that matches the language setting, without preferring default or forced flags. This selects one track; it does not send every available language to the viewer.

If several tracks qualify, Moirai prefers a track associated with the current physical part of a multipart video, then an embedded track over a sidecar. Prefer default checks the default flag before these tie-breakers. Selection is consistent between runs; it does not combine tracks or offer a track picker here. Hearing-impaired and commentary flags are recorded during scanning but are not separate selection filters.

### Preferred language code

Enter a two- or three-letter language code, such as `en` or `eng` for English, or `fr` or `fra` for French. Equivalent codes match the same language. Leave the field blank to allow any language, including tracks with no language tag.

A specified language is a strict filter. For example, **Forced only** with `en` selects an English forced track; an English non-forced track or a French forced track does not qualify. If no track matches, Moirai omits ordinary subtitles instead of falling back to another language. Tracks with an unknown language do not satisfy an explicit language choice.

These are Channel defaults. A [Program](/scheduling/programs) can override subtitle selection, language, and music video credits independently. In nested sequences, more-specific Program choices override inherited values; fields left at **Inherit** retain the enclosing Program or Channel setting. Subtitle mode and the fonts folder remain Channel settings.

### Additional subtitle settings

Expand **Additional subtitle settings** to configure credits, presentation, and fonts.

- **Music video credits:** leave **Off** to use ordinary subtitle selection, or choose a reusable [credit template](/playback/credit-templates) to display music video metadata such as the artist and song title. Credits replace ordinary subtitles on music videos; they are not added on top of lyrics or another subtitle track. Other media continues to use ordinary subtitle selection. Credits work even when **Subtitle selection** is Off, and the preferred subtitle language does not filter generated credits. Use **Manage credit templates** to view, duplicate, or customize a template.
- **Subtitle mode — Burn:** render the selected subtitles into the video picture. Viewers cannot switch these subtitles off in their player. Use this when subtitles should always be visible or when the client cannot display a separate subtitle track.
- **Subtitle mode — Convert:** provide selected text subtitles as a selectable WebVTT track. Viewers need a compatible player to display or hide it. Image-based subtitles, such as PGS or VobSub, are still burned into the picture. Choosing Convert does not enable subtitle selection by itself.
- **Subtitle fonts folder:** optionally supply a folder containing fonts for subtitles in ASS format, including generated credits. Leave it blank to use installed system fonts. The path must be readable by the playback process; in Docker, use the path inside the container and mount the font files there. The folder supplies fonts, while the subtitle file or credit template determines which font to request.

Music video credits on the Channel or a Program in its prepared schedule automatically force **Burn** for the whole Channel, including ordinary subtitles on other videos. Your saved Convert preference is retained and restored when credits are no longer enabled in that schedule. A running stream restarts when the effective mode changes, so enabling or disabling credits can briefly interrupt viewing.

## Guide template override

Expand **Guide template override** to use a specific XMLTV layout for this ![](/icons/tv-minimal.svg) Channel. Leave it on **Default** to follow **Default for XMLTV** under [Guide templates](/playback/guide-templates). Unset channels pick up default changes immediately. Use **Manage guide templates** to view, duplicate, or customize a layout.

![Guide template override with the Default XMLTV layout selected](/screenshots/channel-editor-guide-template.png)

### Check the result

Save the Channel and test a video with a known matching subtitle track. Check the Channel editor for preparation issues if subtitles or credits are missing. Missing tracks, unreadable sidecars, and credit-preparation failures are omitted so Moirai can publish the video without them; a busy credit renderer retries during a later update. A subtitle that passes preparation can still encounter a decoding or rendering failure in the playback engine, so verify the result with your actual files and IPTV client.

## Save and verify

Choose **Save** when the draft is valid, or **Reset** and confirm to discard pending changes. Closing an edited profile prompts you to handle unsaved changes. **Delete Channel** permanently removes the ![](/icons/tv-minimal.svg) Channel after confirmation; it is not a way to discard edits.

After saving, check the ![](/icons/calendar-days.svg) Guide and test live playback in the client you intend to use. Profile settings control output; the assigned ![](/icons/tv-minimal-play.svg) Channel Schedule still determines what plays and when.
