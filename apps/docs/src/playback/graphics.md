---
id: playback.graphics
title: Channel graphics
description: Build reusable overlays from media, shapes, text, and live clocks.
contextual: true
---

# Channel graphics

Graphics presets add watermarks, animated logos, now-playing information, or clocks over video. Build a preset from one or more layers, arrange them in the visual editor, and reuse it wherever you need the same design. Channels provide a base assignment; schedules, Templates, Programs, slots, and Filler presets can add, replace, or disable inherited graphics.

Open **Graphics** in the sidebar. The built-in collection includes protected examples with looping sample-channel previews. Preview an example to inspect its layers, or duplicate it to make an editable copy. Examples work with bundled media and sample schedule data before you have configured a channel.

![Graphics preset cards showing different overlays on the sample channel](/screenshots/graphics-presets.png)

## Layers

A layer is one element of the design: an image or video, a shape, a block of text, or a live clock. Combine layers to build the complete graphic, such as text above a translucent shape with a logo beside it.

The **Layers** list shows the frontmost layer at the top, and you select a row to see its settings and handles in the preview. It's helpful to give layers short names such as “Title,” “Background,” and “Logo” to make the design easier to edit.

![Graphics preset editor with the preview beside the layer list and settings](/screenshots/graphics-editor.png)

### Common settings

The **Layout** group controls placement and appearance. YAML field names are included here and in the layer-specific tables for reference when using the source editor.

| Setting | YAML field | Purpose and values |
| --- | --- | --- |
| Layer name | `name` | Optional editor label, up to 80 characters. It does not appear in the video. |
| Anchor | `anchor` | The point on the layer used to align it with the frame, source picture, or another layer. Choose one of the nine positions below. |
| Horizontal and vertical margins | `horizontalMargin`, `verticalMargin` | Inset from the chosen frame or source anchor, from 0–100%. For example, `4` leaves a 4% margin. Attached layers use offsets instead. |
| Width | `width` | Scale proportionally to 1–100% of the output width. Leave blank to use the original size. Clock layers require 4–25%. |
| Opacity | `opacity` | Overall transparency, from 0% invisible to 100% opaque. Fades and any transparency in the artwork also affect the result. |
| Align | `withinSource` | Enable **Align within source picture** to place the layer inside the active picture when the output has padding, such as letterbox bars. Use `true` in YAML. |
| Rotation | `rotation` | Clockwise rotation around the object’s center, from −180° to 180°. Omitted means 0°. Available for media, shapes, and text. |
| Anchor to | `attachment` | Place the layer relative to another layer rather than the frame or source. Available for media, shapes, and text. |
| Visibility and timing | `timing` | Keep the layer visible, show it once per item, or repeat it. Clock layers are always on. |

The nine anchors are `top_left`, `top_center`, `top_right`, `center_left`, `center`, `center_right`, `bottom_left`, `bottom_center`, and `bottom_right`.

### Move, resize, and rotate

Drag a layer in the editable preview to move it. Media, text, and clocks can be resized proportionally via corner handles. Shapes also have side handles for independent width and height changes. Resizing keeps the layer’s placement anchor fixed.

For media, shapes, and text, drag the circular handle to rotate around the object’s center. Press **Escape** during a gesture to restore the previous position or size. With a handle focused, use the arrow keys to adjust it, or hold **Shift** for a larger step. The numeric layout controls offer the same adjustments without dragging.

### Anchor one layer to another

An attachment keeps a layer aligned with another layer as its size or position changes. Under **Anchor to**, choose a target layer, choose the attached layer’s **Anchor** and the **Target anchor**, then set the offsets.

For example, to place text inside the left side of a shape:

1. Put the shape behind the text in the layer list.
2. Select the text and choose the shape under **Anchor to**.
3. Set both **Anchor** and **Target anchor** to **center left**.
4. Set **Horizontal offset** to `4` and **Vertical offset** to `0`.

The text is vertically centered on the shape’s bounds, with a gutter equal to 4% of the shape’s width. It retains its own size and rotation.

| Attachment field | Purpose | YAML Example |
| --- | --- | --- |
| `layerId` | ID of the target layer in the same preset | `layerId: 2cd52ff4-16dc-4349-9000-166b643d1031` |
| `anchor` | Alignment point on the target | `anchor: center_left` |
| `offsetX` | Horizontal offset, −100 to 100% of the target width. Positive moves right. | `offsetX: 4` |
| `offsetY` | Vertical offset, −100 to 100% of the target height. Positive moves down. | `offsetY: 0` |

Attachments use the target’s rectangular bounds after scaling, skew, and rotation, including parts outside the picture. A target retains its bounds while faded out. Layers can form attachment chains in any draw order, but cannot refer to themselves, missing layers, or create a cycle. Clocks cannot be attachment targets. Reassign dependent layers before removing a target. If a target has no measurable content, such as empty text, its attached layers are omitted for that item and a warning explains why.

### Visibility and timing

Media, shape, and text layers offer three visibility modes:

| Mode | Behavior |
| --- | --- |
| **Always** | Visible throughout the playout item. |
| **Once per playout item** | Wait for a delay, fade in, hold, and fade out once. |
| **Periodic** | Repeat a fade, hold, and fade-out cycle using a content or wall clock. |

A playout item is the piece of content currently being delivered. Content-relative timing starts again for each item, including a new physical part after a split. **Wall clock** follows broadcast time across items, which is useful for graphics that appear at regular clock intervals.

| Timing field | Applies to | Purpose and YAML Example |
| --- | --- | --- |
| `mode` | All modes | `always`, `once`, or `periodic`, for example `mode: once`. |
| `phase` | Once, periodic | Initial delay for once, or offset within the repeating cycle. `phase: 3000` delays by three seconds. |
| `fade` | Once, periodic | Duration of each fade. `fade: 500` gives a half-second fade in and a half-second fade out. |
| `hold` | Once, periodic | Time at full configured opacity between fades. `hold: 4000` holds for four seconds. |
| `clock` | Periodic | `content` restarts with each item; `wall` stays aligned to broadcast time. |
| `frequency` | Periodic | Length of a complete cycle. `frequency: 60000` repeats every minute. |
| `cutoff` | Periodic, optional | Stop starting new appearances after this much time into the item. `cutoff: 180000` stops new appearances after three minutes. |

Timing values are whole milliseconds, up to 86,400,000. Fades must be at least 1 ms and no longer than the hold. Periodic phase must be less than the cycle length, and the hold plus both fades must fit inside one cycle. Cycle length and cutoff must be positive. Keep periodic timing to at most 512 appearances per playout item.

## Media layers

Use a media layer for an existing logo, image, or looping animation. Choose an asset from the **Media** picker, which shows thumbnails, or choose **Upload** beside it to add your own. The same uploaded asset can be used in multiple layers and presets.

| Media type | Supported files | Notes |
| --- | --- | --- |
| Still image | PNG, JPEG, WebP | Use artwork with transparency when the background should remain visible. Animated WebP is not supported. |
| Animated image | APNG, GIF | Plays as a looping overlay. APNG is also recognized when the file has a `.png` extension. |
| Looping video | WebM, MP4 | Use a supported video codec: H.264, HEVC, VP8, VP9, or AV1. Maximum duration is 60 seconds. |

Uploads are limited to 32 MiB and 3840 × 2160 pixels. Images also have decoding limits; animated images can contain up to 240 frames, and large animations may need to be reduced further to fit those limits.

The layer-specific YAML field is `assetId`, the UUID of an uploaded or built-in asset. Select an asset in the visual editor and switch to YAML to see its ID. Files are managed by Moirai; enter an asset ID rather than a path or URL.

Expand **Manage assets** beneath the workspace to upload or remove media and fonts. An asset referenced by a saved preset cannot be deleted until those references are removed. Bundled example assets are protected.

## Shape layers

Use shapes for lower-third backgrounds, tabs, accent lines, and other artwork you want to keep editable. Choose a rectangle, rounded rectangle, ellipse, or line, then adjust its geometry and paint settings.

| Setting | YAML field inside `shape` | Purpose and values |
| --- | --- | --- |
| Type | `primitive` | `rectangle`, `roundedRectangle`, `ellipse`, or `line`. |
| Width | `width` | Source width, 1–1920 pixels, before the layer’s percentage scaling. |
| Height | `height` | Source height, 1–1080 pixels, before percentage scaling. |
| Radius | `radius` | Rounded-rectangle corner radius, 0–540 pixels. Use `0` for other shapes. |
| Fill | `fill` | Solid interior color in six-digit hex, for example `'#18344A'`. Retained in YAML when a gradient is active. |
| Fill mode | `gradient` | Omit for solid fill; add the gradient fields below for a linear fill. Available for closed shapes. |
| Stroke | `stroke` | Outline or line color, for example `'#FFFFFF'`. |
| Stroke width | `strokeWidth` | 0–64 pixels. Zero hides a closed shape’s outline; lines use at least 1 pixel. |
| Skew X | `skewX` | Horizontal skew, −40° to 40°. Optional; defaults to 0°. |
| Skew Y | `skewY` | Vertical skew, −40° to 40°. Optional; defaults to 0°. |

Skew controls are in **Layout**, beside **Rotation**. Scaling, skew, and rotation affect the shape’s bounds and any layers attached to it.

### Gradient fills

Choose **Linear gradient** under **Fill mode** to blend between two colors or fade the shape into the picture. Each end has an independent opacity, so a navy-to-transparent background can keep the text area readable without covering the whole picture.

| Field inside `shape.gradient` | Purpose | YAML Example |
| --- | --- | --- |
| `angle` | Direction, 0–360°. At 90° the gradient runs left to right; at 0° it runs bottom to top. | `angle: 90` |
| `start.color` | Starting color in six-digit hex | `color: '#18344A'` |
| `start.opacity` | Starting opacity, 0–100% | `opacity: 100` |
| `end.color` | Ending color in six-digit hex | `color: '#18344A'` |
| `end.opacity` | Ending opacity, 0–100%. Use 0 to fade into the video. | `opacity: 0` |

## Text layers

A text layer displays authored text, schedule information, or a mixture of both. Enter text in **Text or Liquid template** and use **Insert Liquid field** to insert a placeholder. Placeholders use Moirai’s Liquid syntax, such as <code v-pre>{{ now.title }}</code>. Templates can contain up to 4,096 characters, including line breaks, expressions, and style tags.

### Channel and schedule placeholders

The selected preview channel and live playback use committed schedule data. The sample channel uses the Alpine example data shown below. `now`, `next`, and each entry in `upcoming` describe main airings, skipping filler and schedule gaps. `next` is the same airing as `upcoming[0]`.

| Field | What it contains | Liquid example | Example output |
| --- | --- | --- | --- |
| `channel.name` | Selected channel’s name | <code v-pre>{{ channel.name }}</code> | Moirai TV |
| `channel.number` | Selected channel’s number as text | <code v-pre>{{ channel.number }}</code> | 12 |
| `now` | Current main airing, including during attached filler; otherwise null | <code v-pre>{% if now %}On air{% endif %}</code> | On air |
| `next` | First upcoming main airing, or null | <code v-pre>{{ next.title }}</code> | Mountain Rescue |
| `upcoming` | Up to eight distinct upcoming main airings in chronological order; an empty list when none are scheduled | <code v-pre>{{ upcoming.size }}</code> | 2 |
| `now.title`, `next.title`, `upcoming[0].title` | Title from the channel’s guide template, falling back to the committed airing title | <code v-pre>{{ now.title }}</code> | The Alpine Expedition |
| `now.subtitle`, `next.subtitle`, `upcoming[0].subtitle` | Subtitle from the channel’s guide template, or null if omitted | <code v-pre>{{ now.subtitle }}</code> | A journey through the high Alps |
| `now.start`, `next.start`, `upcoming[0].start` | Full airing’s start as ISO 8601 | <code v-pre>{{ now.start }}</code> | `2026-01-01T14:00:00Z` |
| `now.finish`, `next.finish`, `upcoming[0].finish` | Full airing’s end as ISO 8601 | <code v-pre>{{ now.finish }}</code> | `2026-01-01T14:30:00Z` |
| `now.startTime`, `next.startTime`, `upcoming[0].startTime` | Scheduled start as `HH:mm` in the broadcast time zone | <code v-pre>{{ upcoming[0].startTime }}</code> | `14:30` |

Titles and subtitles follow the channel’s assigned [guide template](/playback/guide-templates), or the default template when none is assigned. If the guide groups content into a block, graphics still uses the template for the individual airing. Use `now.media.title` when you want the raw catalog title instead of the guide’s display title.

### Raw media placeholders

`media` describes the clip actually playing, including filler. `now.media`, `next.media`, and `upcoming[n].media` provide the same fields for their respective airings. Values come from the committed catalog snapshot, with a catalog lookup when the snapshot is missing. Unknown values are null.

| Field on each media object | What it contains | Liquid example | Example output |
| --- | --- | --- | --- |
| `title` | Catalog item title | <code v-pre>{{ now.media.title }}</code> | The Alpine Expedition |
| `subtitle` | Compatibility field; ordinary library items have no reliable raw subtitle source | <code v-pre>{{ media.subtitle }}</code> | Blank |
| `kind` | Catalog item type | <code v-pre>{{ media.kind }}</code> | episode |
| `seriesTitle` | Parent series title for an episode | <code v-pre>{{ now.media.seriesTitle }}</code> | The Alpine Expedition |
| `seasonNumber` | Episode’s season number | <code v-pre>{{ now.media.seasonNumber }}</code> | 1 |
| `episodeNumber` | Episode’s starting number | <code v-pre>{{ next.media.episodeNumber }}</code> | 2 |
| `episodeEndNumber` | Last episode number for a multi-episode item | <code v-pre>{{ now.media.episodeEndNumber }}</code> | 4 |
| `year` | Catalog release year | <code v-pre>{{ media.year }}</code> | 2026 |
| `releaseDate` | Catalog release date | <code v-pre>{{ media.releaseDate }}</code> | `2026-01-01` |
| `description` | Catalog synopsis | <code v-pre>{{ next.media.description }}</code> | A rescue team crosses the Alps. |
| `durationSeconds` | Catalog item duration in seconds | <code v-pre>{{ now.media.durationSeconds }}</code> | 1800 |

During attached filler, `now` continues to identify the main airing while `media` identifies the filler clip. Standalone filler has no `now`, but can still have `next`. At gaps or unavailable positions, the editable preview keeps the real channel name and number and clears item values, with a status message.

Missing values print blank. Use `default` for a fallback, or a conditional to hide a line when its value is absent:

```liquid
Now playing: {{ now.title | default: media.title }}
{% if now.subtitle %}{{ now.subtitle }}{% endif %}
Up next: {{ next.title | default: 'Schedule to be announced' }}
```

To list several upcoming airings, loop over `upcoming`. This example shows at most three:

```liquid
{% for airing in upcoming limit: 3 %}{{ airing.startTime }} {{ airing.title }}{% unless forloop.last %} · {% endunless %}{% endfor %}
```

### Text styling and fonts

The first entry under **Styles** is the base style for the layer. It applies wherever the text has no named style tag. Set the font, size, color, bold, and italic controls there to change the overall appearance.

For emphasis within the same layer, enter a style name and choose **Add style**. The new style starts with the current base settings and can then be edited independently. Select text in the template and choose **Apply to selected text**, or type matching tags yourself:

```liquid
[label]NOW PLAYING[/label]
{{ now.title }}
```

This uses the named style `label` only for “NOW PLAYING”; the title uses the base style. Each named style has its own settings rather than inheriting later base-style changes. Metadata is escaped before style tags are interpreted, so a title containing brackets cannot change the graphic’s formatting. Unknown or mismatched tags appear as literal text.

| Style field | Purpose | YAML Example |
| --- | --- | --- |
| `size` | Required text size, 8–192 | `size: 42` |
| `color` | Required six-digit hex color | `color: '#FFFFFF'` |
| `fontId` | Optional UUID of a managed font. Omit for **System Sans**. | `fontId: 11111111-1111-4111-8111-111111111111` |
| `bold` | Optional bold text | `bold: true` |
| `italic` | Optional italic text | `italic: true` |

In YAML, `style` contains the base style and `styles` contains up to 12 named styles. Names must start with a lowercase letter and may contain lowercase letters, digits, underscores, or hyphens, up to 32 characters. For example, `styles: { label: { size: 42, color: '#8DE7FF', bold: true } }` defines the tag used above.

Upload TTF or OTF fonts through **Manage assets**, then select one in the style’s **Font** control. Select the font visually and switch to YAML to find its `fontId`; replace example IDs with a real uploaded font. Native server installations need Fontconfig to validate font uploads.

## Clock layers

A clock layer displays a rounded badge with bold `HH:mm:ss` digits. It follows Moirai’s configured broadcast time zone and advances during playback, including across midnight and daylight-saving changes. Use this layer for a live clock rather than writing a fixed time into a text layer.

Choose its anchor, margins, width, and overall opacity under **Layout**. Clock width is required and ranges from 4–25% of the output width. The badge keeps its proportions when resized.

| Clock setting | YAML field | Purpose and YAML Example |
| --- | --- | --- |
| Digit color | `badge.color` | Six-digit hex text color, for example `'#FFFFFF'`. |
| Background color | `badge.background` | Six-digit hex badge color, for example `'#0B1F35'`. |
| Background opacity | `badge.backgroundOpacity` | Badge transparency from 0–100%, for example `90`. This leaves digit opacity unchanged. |

Clock layers are always on and use frame or source placement. They cannot rotate, attach to another layer, or serve as an attachment target. In YAML, use `timing: { mode: always }` and omit `rotation` and `attachment`.

Gallery clocks use a deterministic sample time that advances in the looping clip. A selected-channel preview derives the displayed time from the chosen schedule position.

## Create or duplicate a preset

1. Open **Graphics** and choose **New Graphics Preset**, or choose **Duplicate** on an existing card. You can also open a protected example with **Preview** and choose **Duplicate** in its footer.
2. Enter the preset’s name in the titlebar. In the **Layers** toolbar, choose **+**, then **Add media**, **Add shape**, **Add text**, or **Add clock**.
3. Name and arrange the layers. Adjust their settings, drag or resize them on the canvas, and set visibility timing where needed.
4. Use **Preview channel** to choose the sample channel or one of your channels. Move the **Elapsed time** slider to inspect another position. A real channel supplies its committed schedule labels to the editable canvas; the sample channel uses the bundled mountain image and Alpine schedule.
5. Choose **Preview** to render a frame with the playback engine. The frame uses the selected channel’s scheduled video, or the mountain still for the sample channel. A progress overlay keeps the current picture and controls in place. Choose **Edit** to return to direct manipulation.
6. Choose **Save** to keep the preset. **Reset** restores the saved draft after confirmation. Closing with unsaved changes offers Save, Discard, and Cancel.

For a real channel, elapsed time is measured from the start of the reference airing selected from its committed schedule. Preview positions without playable main video cannot produce a rendered frame. Choose another position or channel if a gap or unavailable video prevents rendering.

For periodic wall-clock graphics, enable **Show wall-clock layers outside their scheduled times** to inspect their placement even when they would normally be hidden. Turn it off to check the actual visibility at the selected time.

The renderer retries a busy response once after one second. Other failures show guidance on the canvas and leave **Retry** in the same position as **Preview**. Changing the draft, channel, or elapsed time cancels the previous preview request. If playback cannot prepare an assigned graphic, the underlying video continues and a graphics warning identifies the problem.

### Assign the preset

For a channel-wide graphic, edit a channel in **Channels**, expand **On-screen graphics**, choose the preset, and save. Choose **No graphics** to remove the channel assignment. Saving a preset alone does not assign it to any channel.

Schedules, Templates, Programs, slots, and Filler presets can modify the graphics they inherit:

| Choice | Result |
| --- | --- |
| Inherit | Keep the inherited graphics. |
| **Add to inherited graphics** | Place the selected preset above the inherited graphics. |
| **Replace inherited graphics** | Use only the selected preset at this level. |
| **No graphics** | Clear the inherited graphics at this level. |

Use a Program assignment for its content, or a slot assignment for just one placement. For a branded break, assign graphics on the Filler preset or its source Program. The main Program’s graphics stay with the main content; text assigned to the filler source or break can describe that filler clip.

![Filler preset with an added animated corner graphic](/screenshots/filler-graphics-assignment.png)

Saved presets cannot be deleted while assigned, and referenced assets cannot be removed. Reassign or clear their uses first. Protected examples can be previewed and duplicated, but not changed or deleted.

### Schedule a full-screen interstitial

For a bumper or promo that interrupts the video, add the clip to a media library and include it in a [Program](/scheduling/programs). Create a [pre-roll, mid-roll, or post-roll Filler preset](/filler/presets), then assign it in the [channel schedule](/scheduling/channel-schedules) and choose that Program as its source. Pre-roll plays before the main content, mid-roll during breaks, and post-roll after it. Add a graphics assignment to the break if the clip also needs an overlay.

## Edit YAML directly

Choose **YAML** in the editor header to edit or copy the same draft used by **Visual** mode. Both modes validate the same preset format. Invalid source stays in the editor with diagnostics; fix it before saving or returning to visual editing. Visual changes preserve comments where the YAML structure permits.

A document contains `version: 1` and a `layers` list. YAML lists layers from back to front, the reverse of the visual layer list. Common settings and each layer type’s fields are described above.

| Field | Requirement | YAML Example |
| --- | --- | --- |
| `version` | Required format version; use `1` | `version: 1` |
| `layers` | Required ordered list, up to eight layers | `layers: []` |
| `id` | Required unique UUID for each layer in the preset | `id: 2cd52ff4-16dc-4349-9000-166b643d1031` |
| `kind` | Required layer type: `media`, `shape`, `text`, or `clock` | `kind: text` |

Every layer also requires `anchor`, `horizontalMargin`, `verticalMargin`, `opacity`, `withinSource`, and `timing`. `name`, `rotation`, `attachment`, and percentage `width` are optional, with the clock restrictions described above. Media requires `assetId`; shape requires `shape`; text requires `text` and `style`; clock requires `width` and `badge`. Shape geometry requires all fields except `gradient`, `skewX`, and `skewY`. A gradient requires its angle and both color/opacity endpoints. Each text style requires size and color; bold, italic, and font are optional.

Duplicate an example and switch to YAML for a complete working definition. The following example puts styled text over a rounded navy background, using a layer attachment to maintain the gutter:

```yaml
version: 1
layers:
  - id: 2cd52ff4-16dc-4349-9000-166b643d1031
    name: Background
    kind: shape
    anchor: bottom_left
    horizontalMargin: 4
    verticalMargin: 5
    opacity: 90
    withinSource: true
    timing: { mode: always }
    shape:
      primitive: roundedRectangle
      width: 960
      height: 160
      fill: '#18344A'
      stroke: '#FFFFFF'
      strokeWidth: 0
      radius: 12
  - id: 2cd52ff4-16dc-4349-9000-166b643d1032
    name: Title
    kind: text
    anchor: center_left
    attachment:
      layerId: 2cd52ff4-16dc-4349-9000-166b643d1031
      anchor: center_left
      offsetX: 4
      offsetY: 0
    horizontalMargin: 0
    verticalMargin: 0
    width: 40
    opacity: 100
    withinSource: true
    timing: { mode: always }
    style:
      size: 42
      color: '#FFFFFF'
    styles:
      label:
        size: 28
        color: '#0CD9B4'
        bold: true
    text: |
      [label]NOW PLAYING[/label]
      {{ now.title | default: media.title }}
```

The preset’s title is edited separately in the titlebar; it is not a field in this YAML document. Asset and font references use managed IDs. Unsupported fields, raw file paths, remote URLs, and playback-engine expressions are not part of the authoring format.
