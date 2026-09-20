---
id: playback.guide-templates
title: Guide templates
description: Control how channels and programmes appear in the published XMLTV guide.
contextual: true
---

# Guide templates

Open **Playback → Guide templates** to manage reusable XMLTV layouts. Each template has a tab for the channel listing and for each `programme` type: Episode, Movie, Music Video, Other, Filler, No programming, and Block.

![Guide template cards with the built-in Standard XMLTV layout](/screenshots/guide-templates.png)

Channels that do not choose a template use **Default for XMLTV**. Changing the default updates those channels’ published guide. You can open **Used by** in the editor title bar of any saved template to see channels that use it.

## Built-in template

The included **Standard XMLTV** template provides a basic guide similar to any current live TV streaming service. You can click **View** to inspect its template or choose **Duplicate** to create an editable copy. Built-in templates cannot be edited or deleted.

The built-in layout identifies movies with a `Movie` category and episodes with a `Series` category, alongside their genres. This lets clients such as Channels DVR recognize movies in automatic collections. Built-in layouts update with Moirai; saved custom copies keep their own content. For an existing custom template, add `<category>Movie</category>` inside the Movie tab’s `<programme>` element and `<category>Series</category>` inside the Episode tab’s `<programme>` element, or leave those tabs empty to use the built-in layouts. After updating, refresh the XMLTV guide in your client.

![Built-in guide template viewer with a Duplicate action](/screenshots/guide-template-view.png)

## Edit a template

Give the template a distinct name and an optional single-line description. Each tab is a [Liquid](https://liquidjs.com/tutorials/intro-to-liquid.html) source that emits one XMLTV `<channel>` or `<programme>` fragment. If you leave any type's tab completely empty, it will use the built-in layout for that type.

Templates can use the listing `kind`, XMLTV `start` and `stop` times, channel identity, item metadata (including the media type), the slot interval, and block title and description. Interpolated text is escaped automatically.

**Save** stores the template. **Reset**, once confirmed, restores the opening draft. Deleting a template requires confirmation and is blocked while any channel assigns it or while it is set as the default.

## Preview

The editor preview shows one local day of the selected channel as a guide. Click on any part of a listing or the channel name to view each available Liquid template key and what it equals for that item.

![Guide template editor with type tabs and a one-day preview](/screenshots/guide-template-editor.png)

If there are no channels, you'll need to create one before previewing. A failed refresh (e.g,. due to a template syntax error) displays the error so you can correct the draft before saving.

## Assign a template to a channel

Edit a [Channel](/scheduling/channels), expand **Guide template override**, and choose a template. Leave it on **Default** to follow **Default for XMLTV**.
