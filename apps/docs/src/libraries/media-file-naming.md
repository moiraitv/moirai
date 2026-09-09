---
id: libraries.file-naming
title: Media file naming
description: Organize movies, shows, artwork, subtitles, and metadata so your library stays readable and portable.
contextual: false
---

# Media file naming

Clear names help Moirai distinguish titles, keep episodes in order, and find the artwork and metadata that belong to each video. They also make your collection easier to maintain outside Moirai.

The examples here favor readable, consistent names over every variation that is accepted.

## Start with these layouts

Keep movies, shows, and music videos in separate source folders and choose the corresponding library type in Moirai. Point the library at the folder containing the movies, series, or artists — not at one individual movie or season.

### Movies

```text
Movies/
└── Afterlight Station (2026)/
    ├── Afterlight Station (2026).mkv
    ├── Afterlight Station (2026).nfo
    ├── Afterlight Station (2026).eng.srt
    └── poster.jpg
```

### Shows

```text
Shows/
└── Harbor Stories (2025)/
    ├── tvshow.nfo
    ├── poster.jpg
    ├── Season 01/
    │   ├── season.nfo
    │   ├── poster.jpg
    │   ├── Harbor Stories s01e01 First Arrival.mkv
    │   ├── Harbor Stories s01e01 First Arrival.nfo
    │   └── Harbor Stories s01e01 First Arrival-thumb.jpg
    └── Specials/
        └── Harbor Stories s00e01 Winter Visit.mkv
```

The `.nfo`, image, and subtitle files are companions to the video, often called **sidecars**. You do not need every companion file to start a library. Keep the ones you use alongside the matching video or in the show or season folder they describe.

## Name movies with a title and year

Use the same title and release year for the folder and video:

```text
Movie Name (2025)/Movie Name (2025).mkv
```

The year helps distinguish remakes and unrelated films with the same title. One movie per folder also prevents a shared `poster.jpg` or metadata file from being mistaken for another movie's files. Moirai can scan videos without individual folders, but dedicated folders are easier to maintain.

Use spaces for readability. Replace characters that can cause filesystem problems, such as `:`, `/`, and `\`, with safe alternatives. For example, use `Movie Name - The Return` instead of `Movie Name: The Return`. Keep spelling and punctuation consistent across matching files; some filesystems distinguish uppercase and lowercase names.

### Distinguish titles with provider IDs

For titles that remain ambiguous, a provider ID identifies the work in a metadata database. Moirai reads brace tags such as `{tmdb-603}` and `{imdb-tt0133093}`:

```text
The Matrix (1999)/The Matrix (1999) {tmdb-603}.mkv
```

Use the actual ID for that title, not an invented number. Keep the tag when naming matching sidecars:

```text
The Matrix (1999) {tmdb-603}.mkv
The Matrix (1999) {tmdb-603}.nfo
```

An ID supplies identity information; it is not a request for Moirai to download a description or poster. Moirai reads local metadata and artwork. If an NFO contains incorrect information, fix that file as well as the filename.

### Keep alternate editions distinct

Use an edition tag for different cuts or versions:

```text
Blade Runner (1982)/
├── Blade Runner (1982) {edition-Theatrical}.mkv
└── Blade Runner (1982) {edition-Director's Cut}.mkv
```

Moirai recognizes edition tags. Give each version matching sidecars when its metadata or artwork differs. Do not use `part1` and `part2` to distinguish editions: those names mean consecutive pieces of one item, not alternative versions.

## Name shows with season and episode numbers

Use a series folder, a season folder, and an explicit season/episode marker in each filename:

```text
Harbor Stories (2025)/Season 01/Harbor Stories s01e02 The Crossing.mkv
```

Here, `s01e02` means season 1, episode 2. Pad small numbers with a leading zero so files sort neatly. The episode title is optional, but makes the file easier to recognize. Moirai also reads forms such as `01x02`; using one convention throughout a collection is simpler than mixing them.

Use the series' starting year in its folder name. Keep different series in separate folders rather than placing unrelated episodes in one season directory.

### Specials and episode order

Use season zero for specials, inside `Specials` or `Season 00`:

```text
Harbor Stories (2025)/Specials/Harbor Stories s00e01 Winter Visit.mkv
```

Check the numbering against the episode order you intend to use. Broadcast order and DVD order may differ. Renaming a file does not change its contents, and Moirai cannot infer the intended order from the video itself. If episode NFO files are present, keep their season and episode numbers consistent with the filenames; Moirai prefers those metadata values when provided.

### One file containing multiple episodes

Put the first and last episode numbers in the name:

```text
Harbor Stories s01e03-e04 The Long Weekend.mkv
```

Moirai records the episode range, but this is still one video file. Naming a range does not split it into independently playable episodes because the split timestamp is not present in the typical metadata. Use separate video files if you need to schedule them separately.

## Handle movies or episodes split across files

For consecutive pieces of one movie or episode, use a common name followed by numbered part suffixes:

```text
Afterlight Station (2026) - part1.mkv
Afterlight Station (2026) - part2.mkv
```

The same pattern works for an episode, such as `Harbor Stories s01e05 Homecoming - part1.mkv`. Moirai also recognizes `disc`, `cd`, `dvd`, and `disk` suffixes. Prefer one style and keep all parts in the same folder.

Moirai groups matching parts into one catalog item. Number them consecutively from 1, without gaps or duplicate numbers. Missing parts or ambiguous numbering cause scan warnings and prevent the item from having a usable scheduling duration. An alternate cut is not another part of the same movie.

## Add local metadata

An NFO is a small text file containing structured metadata, such as a title, description, genres, cast, or release year. Use Kodi-compatible NFO files, with a matching video basename:

```text
Afterlight Station (2026).mkv
Afterlight Station (2026).nfo
```

For shows, use `tvshow.nfo` in the series folder, `season.nfo` in the season folder, and matching NFO files beside individual episodes. These describe different levels of the collection.

Moirai uses NFO values before filename-derived values when they are supplied. A better filename will not override an incorrect NFO title or episode number. Technical playback information, including duration, comes from inspecting the media rather than trusting descriptive NFO metadata.

## Add posters and episode images

For a simple setup, use these names with JPG or PNG images:

| What the image describes | Where to place it | Recommended name |
| --- | --- | --- |
| A movie | Inside its movie folder | `poster.jpg` |
| One video among several versions | Beside that video | `Video Filename-poster.jpg` |
| A series | Inside its series folder | `poster.jpg` |
| A season | Inside its season folder | `poster.jpg` |
| An episode | Beside that episode | `Episode Filename-thumb.jpg` |
| An artist or album | Inside that artist or album folder | `cover.jpg` |

Replace `Video Filename` or `Episode Filename` with the complete video name without its extension. For example, `Harbor Stories s01e01 First Arrival-thumb.jpg` belongs beside `Harbor Stories s01e01 First Arrival.mkv`.

Moirai recognizes additional primary-image names, including `folder`, `cover`, and `default`, and can read local artwork references from NFO files. You do not need to duplicate the same image under every alias. An NFO artwork reference can take precedence over the conventional files beside the video.

The source article also describes fanart, banners, logos, disc art, and other artwork used by media centers. Keeping these files may help with library portability, but it does not mean Moirai displays each category separately. Start with a poster or episode thumbnail and check the catalog after scanning.

## Name subtitle sidecars

Match the full video basename, then append a language code and an optional flag:

```text
Afterlight Station (2026).mkv
Afterlight Station (2026).eng.srt
Afterlight Station (2026).spa.srt
Afterlight Station (2026).eng.forced.srt
```

Here, `eng` identifies English and `spa` identifies Spanish. A `forced` track typically supplies translations for selected dialogue or signs; `default` expresses a preferred track. Subtitles can also be embedded inside the video, which keeps them together when copying the file.

Moirai inventories embedded and matching sidecar subtitle tracks. Discovery is not a guarantee that a particular track will be selected or shown during playback; do not rely on the filename flag alone to determine what viewers see. Test the channel with your playback settings and IPTV client.

## Organize music videos and other material

For a music-video library, use artist and album folders with numbered video files:

```text
Music Videos/
└── Example Artist/
    └── Evening Sessions/
        ├── 01 - Opening Night.mkv
        ├── 01 - Opening Night.nfo
        ├── Example Artist - Evening Sessions.nfo
        └── cover.jpg
```

Moirai uses this hierarchy for artist and album grouping. It also reads embedded music-video tags, so check those tags if renaming a file does not change the displayed title. Local NFO values take precedence when present.

The article's audio-only music examples describe broader media-center organization, not an audio library workflow in Moirai. For miscellaneous videos, choose clear, consistent titles and provide local metadata where useful rather than assuming a movie or episode naming rule fits everything.

### Keep extras out of ordinary programming unless intended

Folders such as `Trailers`, `Featurettes`, `Deleted Scenes`, and `Interviews` may be used for media centers that associate extras with a feature. Moirai scans supported video files recursively; those folder names do not automatically exclude extras from its catalog or attach them to a movie.

Keep extras outside the source you scan for normal programming, or deliberately restrict your [program's selection](/scheduling/programs) so supplemental videos are not chosen unintentionally.

## Rename an existing library safely

You do not need to reorganize a working collection all at once. Try a small group first:

1. Keep a backup of the metadata and a record of the original paths before a bulk rename.
2. Rename the video and matching NFO, artwork, and subtitle sidecars together.
3. Check that Moirai can still access the files, including the container paths when using Docker.
4. Select ![Sync library](/icons/refresh-cw.svg) and wait for the scan to finish.
5. Check titles, years, episode order, artwork, and scan warnings in the catalog.
6. Review affected programs and schedule previews before continuing with the rest of the collection.

If files appear missing, follow [Missing media and conflicts](/libraries/reconciliation). Do not approve indexed removals just to dismiss a warning when the files were only moved or renamed.

For unexpected results, check spelling, release years, season/episode numbers, mismatched sidecar names, and stale NFO values first. Consistent names reduce ambiguity, but they cannot fix missing files, inaccessible mounts, incorrect metadata, or an unreadable video.
