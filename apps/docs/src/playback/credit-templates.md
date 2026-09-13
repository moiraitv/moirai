---
id: playback.credit-templates
title: Music video credit templates
description: Create styled artist, song, and album credits and choose when they appear.
contextual: true
---

# Music video credit templates

Credit templates show song information over music videos. Open **Playback → Credit templates**, choose **New template**, and start with the included design. Templates are reusable: choose a default in a Channel’s **Subtitles and music video credits** settings, or select an override in a Program.

Expand **Used by** in a saved credit template to see its explicit channel and program assignments. These are direct references, not a complete list of channels that may inherit the template through their programs.

## Built-in template

The included **Music video credits** template offers a classic-style music video credits intro and outro. Choose **View** to inspect its source or render a preview. Choose **Duplicate** on its card or in the viewer to create an editable copy.

![Credit template cards with the built-in music video design](/screenshots/credit-templates.png)

![Built-in credit template viewer with a Duplicate action](/screenshots/credit-template-view.png)

## Edit and preview a template

Give the template a distinct name and an optional single-line description. The **Credit template (Liquid)** editor uses [Liquid expressions and tags](https://liquidjs.com/tutorials/intro-to-liquid.html) to generate a subtitle document in [Advanced SubStation Alpha (ASS) format](https://aegisub.org/docs/latest/ass_tags/).

![Credit template editor with the included music video design](/screenshots/credit-template-editor.png)

Choose a music video from the preview carousel, set the source time in seconds, and choose **Render preview**. The preview uses the default encoding profile’s resolution and scaling with installed system fonts; no Channel is required. Audio settings do not affect the still image. 

![Music video carousel and preview controls using the default encoding profile](/screenshots/credit-template-preview.png)

If a video has no measured duration, check FFprobe in **Status** and rescan its library before previewing. The preview area expands and scrolls into view. Expand **Generated subtitles (.ass)** to inspect the output. Errors are shown when applicable so you can correct the draft before saving.

**Save** stores the template. **Reset** asks for a second confirmation before restoring the opening draft. **Duplicate** creates an independently editable copy. Deleting a template requires confirmation and is blocked while a Channel or Program references it.

## Metadata and timing

Templates can use `title`, `artist`, `all_artists`, `album`, `track`, `plot`, `release_date.year`, `studios`, `directors`, `duration.total_seconds`, `resolution.width`, and `resolution.height`. Lists support Liquid filters such as `uniq` and `join`. Optional text is empty, optional numbers and release dates may be null, and missing lists are empty. Check `release_date` before using its year. Catalog text is escaped automatically so titles cannot introduce subtitle formatting commands.

Use the `ass_time` filter to format seconds as an ASS timestamp, for example `{{ 7 | ass_time }}`. The included design displays opening credits at 7–17 seconds when the video is longer than a minute, and closing credits from 15 to 5 seconds before the end. Very short videos use only valid remaining intervals. Edit the template to change these times, styling, margins, and fades.

Timing is fixed relative to the original video. Tuning in midway does not restart the opening credits. Clipped and multipart playback keep the same source-relative timing.

## Enable credits and fonts

Moirai automatically uses **Burn** for the whole Channel when credits are enabled on the Channel or a Program in its prepared schedule. The saved subtitle mode is retained and resumes when credits are no longer enabled in that schedule. A running stream restarts when the effective mode changes. Generated credits take precedence over ordinary subtitles on music videos; they do not appear on other media. Credits can be enabled while ordinary subtitle selection is **Off**. A Program can inherit settings or explicitly disable or replace its inherited template. In nested sequences, the most specific Program override wins.

The included design uses Noto Sans for song, artist, and album text, and Noto Mono for studio and director credits. Both fonts are available in the Moirai Docker image. For other installations, install those fonts on the playback server. To use different fonts in a custom template, choose installed fonts or set the Channel’s **Subtitle fonts folder** to a directory visible to the playback worker. Missing fonts may be substituted. FFmpeg must include the ASS subtitle filter (libass) for rendering and preview.

Templates are limited to 65,536 characters and generated documents to 1 MiB. Rendering has execution limits, and templates cannot load files. If a template or subtitle cannot be prepared, the video continues without it and the Channel editor shows the issue. When the renderer is busy, work waits for capacity; if its queue is full, playback continues without those credits and retries during the next update. Retry a preview or save if it reports that the renderer is busy. Saved changes are picked up by playback reconciliation; already buffered video is unchanged.
