---
id: channels.manage
title: Channels
description: Configure the identity and playback profile viewers receive.
contextual: true
---

# ![](/icons/tv-minimal.svg) Channels

To build a channel and its linked programming in one workflow, use [Quick Setup](/getting-started/first-channel). Return to the full editors for later adjustments.

A ![](/icons/tv-minimal.svg) Channel combines a viewer-facing number and name with playback settings. Open **![](/icons/tv-minimal.svg) Channels** to create or edit one and to review its resolved seven-day timeline.

![The channels page](/screenshots/channels.png)

## Open the Channel editor

Choose **New Channel**, or use the pencil button beside an existing ![](/icons/tv-minimal.svg) Channel. The **Broadcast profile** editor controls its identity and the video/audio format delivered to viewers. Its **Save** and **Reset** actions stay at the bottom while you scroll through the settings.

![Channel Broadcast profile editor showing the Lineup configuration](/screenshots/channel-editor.png)

## Lineup: identity and schedule

- **Number** identifies the ![](/icons/tv-minimal.svg) Channel in the lineup. Numbers must be distinct; choose stable values because IPTV applications may use them when organizing favorites.
- **Name** is the viewer-facing name.
- **Group** provides a category for the lineup, such as “Movies.” How groups appear depends on the IPTV client.
- **Manage Layered Schedule** opens the ![](/icons/tv-minimal-play.svg) [Channel Schedule](/scheduling/channel-schedules), where you assign ![](/icons/calendar-range.svg) Templates and conditions. Save a new or changed ![](/icons/tv-minimal.svg) Channel first; the schedule link is disabled while the profile has pending changes.

### Channel logo

![Channel logo picker and external URL controls](/screenshots/channel-editor-logo.png)

A logo is optional. Choose **Choose Image** to select a local image, then adjust the crop before saving. The editor accepts browser-supported images such as JPEG, PNG, and WebP, up to the displayed source-size limit. Uploaded logos are saved as PNG; the editor shows the output size limit, and cropping does not upscale the source image.

Alternatively, enter an HTTP(S) address under **Or use an external logo URL**. Use an image address rather than a webpage. Remove an existing logo with its remove button and confirm the action, then save the profile. Choosing or removing an image is a draft change until **Save**.

### Channel fallback override

![Channel fallback video controls showing the effective source and upload action](/screenshots/channel-editor-fallback.png)

**Channel fallback override** lets this ![](/icons/tv-minimal.svg) Channel use its own fallback video instead of the effective global fallback. The panel shows the current source, file details, and a preview. Choose **Choose Video** (or **Choose Another**) to select a supported video up to 512 MiB; its video and audio are checked when saved. Silence is synthesized if the video has no audio.

Removing the override and saving returns this ![](/icons/tv-minimal.svg) Channel to the effective global fallback, which may be a global custom video or Moirai's bundled fallback. This is different from selecting a filler ![](/icons/list-video.svg) Program in a ![](/icons/calendar-range.svg) Template or ![](/icons/tv-minimal-play.svg) Channel Schedule: those rules schedule library media, while this setting supplies the playback fallback video. It does not remove ![](/icons/calendar-days.svg) Guide warnings; fix recurring scheduling gaps where possible.

## Video normalization

![Video normalization controls for format, resolution, bitrate, scaling, acceleration, and deinterlacing](/screenshots/channel-editor-video.png)

Normalization gives the ![](/icons/tv-minimal.svg) Channel a consistent output format even when its source files differ. Start with the defaults and change settings to match your clients and server capacity.

- **Format:** choose H.264 or HEVC. Confirm that your playback clients support the selected format.
- **Width** and **Height:** set the output resolution. Larger output can require more processing and bandwidth.
- **Bitrate kbps:** controls the target video bitrate. **Buffer kbps** configures the encoder's rate-control buffer; it is not the client's playback buffer or the size of the transcode folder.
- **Bit depth:** sets the output color precision. The selected codec, encoder, and clients must support it.
- **Scaling:** **Scale and pad** preserves proportions and adds borders where needed; **Stretch** fills the frame by changing proportions; **Crop** fills it by removing edges.
- **Acceleration:** **Automatic** lets Moirai choose a supported path; the editor may show its predicted choice. **None** disables hardware acceleration. Explicit options such as VAAPI, QSV, CUDA, AMF, RKMPP, VideoToolbox, and Vulkan require a compatible host and playback engine. In Docker, the necessary devices and permissions must also be passed through; see [Install with Docker](/getting-started/docker).
- **Deinterlace:** enables processing for interlaced sources. Leave it off unless your source material requires it.

An acceleration option appearing in the menu does not mean this machine supports it. Test live playback after changing codec, bit depth, resolution, or acceleration, and check logs if the stream fails.

## Audio normalization and subtitles

![Audio normalization controls for codec, bitrate, channels, sample rate, loudness, and subtitle mode](/screenshots/channel-editor-audio.png)

- **Format:** choose AAC or AC3 to suit the playback clients.
- **Bitrate kbps:** sets the target audio bitrate.
- **Channels:** sets the output audio channel count—for example, 2 for stereo. This is not the number of IPTV ![](/icons/tv-minimal.svg) Channels.
- **Sample rate:** sets the audio sampling frequency in hertz, such as 48000.
- **Normalize loudness:** enables loudness normalization to reduce volume differences between source items.
- **Subtitle mode:** **Burn** renders selected subtitles into the picture. **Convert** presents selected text subtitles as a selectable WebVTT track; image subtitles are still burned. Enabling music-video credits on the Channel or a Program in its prepared schedule automatically uses Burn for the whole Channel. Your saved mode is retained for when credits are disabled. A running stream restarts when the effective mode changes.

![Subtitle selection and additional subtitle settings](/screenshots/channel-editor-subtitles.png)

Expand **Additional subtitle settings** to choose music-video credits, subtitle mode, or a fonts folder. The panel opens and closes smoothly and respects reduced motion.

Under **Subtitles**, choose **Off**, **Forced only**, **Prefer default**, or **Any matching track**. Prefer default falls back to another matching track when none is flagged default. Enter a two- or three-letter language code, such as `en` or `eng`, or leave it blank for any language. An explicit language never falls back to a different language. Programs can override these defaults.

Choose a reusable [music-video credit template](/playback/credit-templates) independently of ordinary subtitle selection. Existing Channels start with both ordinary subtitles and credits Off. The **Subtitle fonts folder** supplements installed system fonts for ASS rendering.

## Save and verify

Choose **Save** when the draft is valid, or **Reset** and confirm to discard pending changes. Closing an edited profile prompts you to handle unsaved changes. **Delete Channel** permanently removes the ![](/icons/tv-minimal.svg) Channel after confirmation; it is not a way to discard edits.

After saving, check the ![](/icons/calendar-days.svg) Guide and test live playback in the client you intend to use. Profile settings control output; the assigned ![](/icons/tv-minimal-play.svg) Channel Schedule still determines what plays and when.
