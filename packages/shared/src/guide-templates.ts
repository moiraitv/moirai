import { z } from 'zod';
import { guideEntrySchema } from './guide.js';

/** Largest Liquid source accepted for one XMLTV template tab. */
export const MAX_GUIDE_TEMPLATE_SOURCE_LENGTH = 65_536;

/** Programme kinds that each have a dedicated Liquid source tab. */
export const GUIDE_PROGRAMME_KINDS = [
	'episode',
	'movie',
	'music-video',
	'other',
	'filler',
	'dead-air',
	'block',
] as const;

/** Liquid source tabs, including the XMLTV channel fragment. */
export const GUIDE_TEMPLATE_SOURCE_KEYS = ['channel', ...GUIDE_PROGRAMME_KINDS] as const;

/** Editor labels for each XMLTV template tab. */
export const GUIDE_TEMPLATE_TAB_LABELS = {
	channel: 'Channel',
	episode: 'Episode',
	movie: 'Movie',
	'music-video': 'Music Video',
	other: 'Other',
	filler: 'Filler',
	'dead-air': 'No programming',
	block: 'Block',
} as const;

/** One XMLTV template tab identifier. */
export type GuideTemplateSourceKey = (typeof GUIDE_TEMPLATE_SOURCE_KEYS)[number];
/** One XMLTV programme kind that selects a template tab. */
export type GuideProgrammeKind = (typeof GUIDE_PROGRAMME_KINDS)[number];

/** Empty tab map used when a draft has not authored a kind yet. */
export function emptyGuideTemplateSources(): GuideTemplateSources {
	return {
		channel: '',
		episode: '',
		movie: '',
		'music-video': '',
		other: '',
		filler: '',
		'dead-air': '',
		block: '',
	};
}

/** Replace blank tabs with the matching built-in source. */
export function resolvedGuideTemplateSources(
	sources: GuideTemplateSources,
): GuideTemplateSources {
	const resolved = emptyGuideTemplateSources();
	for (const key of GUIDE_TEMPLATE_SOURCE_KEYS) {
		resolved[key] = sources[key].trim() || BUILTIN_GUIDE_TEMPLATE.sources[key];
	}
	return resolved;
}

/** One Liquid source string per XMLTV template tab. */
export const guideTemplateSourcesSchema = z.object({
	channel: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	episode: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	movie: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	'music-video': z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	other: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	filler: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	'dead-air': z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
	block: z.string().max(MAX_GUIDE_TEMPLATE_SOURCE_LENGTH).default(''),
}).strict();

/** Complete draft accepted when creating or replacing a guide template. */
export const guideTemplateCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).default(''),
	sources: guideTemplateSourcesSchema,
}).strict();

/** Persisted reusable XMLTV template. */
export const guideTemplateSchema = guideTemplateCreateSchema.extend({
	id: z.uuid(),
	isBuiltin: z.boolean().default(false),
	isDefault: z.boolean().default(false),
	createdAt: z.string(),
	updatedAt: z.string(),
});

/** Preview draft sources against one channel's committed local day. */
export const guideTemplatePreviewSchema = z.object({
	sources: guideTemplateSourcesSchema,
	channelId: z.uuid(),
}).strict();

/** One Liquid placeholder and its resolved preview value. */
export const guideTemplatePreviewValueSchema = z.object({
	name: z.string(),
	value: z.string(),
});

/** One local day of listings rendered from unpublished template sources. */
export const guideTemplatePreviewResultSchema = z.object({
	timeZone: z.string(),
	startDate: z.iso.date(),
	entries: z.array(guideEntrySchema),
	channelValues: z.array(guideTemplatePreviewValueSchema),
	listingValues: z.record(z.string(), z.array(guideTemplatePreviewValueSchema)),
});

/** Authored tab map stored with a guide template. */
export type GuideTemplateSources = z.infer<typeof guideTemplateSourcesSchema>;
/** Persisted reusable XMLTV template. */
export type GuideTemplate = z.infer<typeof guideTemplateSchema>;
/** Complete draft accepted when creating or replacing a template. */
export type GuideTemplateCreate = z.infer<typeof guideTemplateCreateSchema>;
/** Preview request using unpublished sources. */
export type GuideTemplatePreview = z.infer<typeof guideTemplatePreviewSchema>;
/** One-day guide listing preview. */
export type GuideTemplatePreviewResult = z.infer<typeof guideTemplatePreviewResultSchema>;
/** One Liquid placeholder and its resolved preview value. */
export type GuideTemplatePreviewValue = z.infer<typeof guideTemplatePreviewValueSchema>;

/** Stable identity for the protected XMLTV layout that matches current output. */
export const BUILTIN_GUIDE_TEMPLATE_ID = '20000000-0000-4000-8000-000000000002';

const CHANNEL_SOURCE = `{% comment %}
Available values:
  - channel.id (XMLTV identifier)
  - channel.number
  - channel.name
  - channel.logo_url

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <channel id="{{ channel.id }}">
    <display-name>{{ channel.number }} {{ channel.name }}</display-name>
    <display-name>{{ channel.number }}</display-name>
    <display-name>{{ channel.name }}</display-name>
{%- if channel.logo_url %}
    <icon src="{{ channel.logo_url }}" />
{%- endif %}
  </channel>`;

const EPISODE_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
{%- if item and item.title %}
    <title>{{ item.title }} {%- if item and item.season_number and item.episode_number %} ({{ item.season_number }}.{{ item.episode_number }}) {%- endif %}</title>
    <sub-title>{{ title }}</sub-title>
{%- else %}
    <title>{{ title }}</title>
{%- endif %}
{%- if item and item.plot %}
    <desc>{{ item.plot }}</desc>
{%- endif %}
{%- if item and item.year %}
    <date>{{ item.year }}</date>
{%- endif %}
{%- if item %}
{%- for genre in item.genre_names %}
    <category>{{ genre }}</category>
{%- endfor %}
{%- endif %}
{%- if item and item.xmltv_episode_num %}
    <episode-num system="xmltv_ns">{{ item.xmltv_episode_num }}</episode-num>
{%- endif %}
{%- if item and item.artwork_url %}
    <icon src="{{ item.artwork_url }}" />
{%- endif %}
  </programme>`;

const MOVIE_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
{%- if item and item.year %}
    <title>{{ title }} ({{ item.year }})</title>
{%- else %}
    <title>{{ title }}</title>
{%- endif %}
{%- if item and item.show_title %}
    <sub-title>{{ item.title }}</sub-title>
{%- endif %}
{%- if item and item.plot %}
    <desc>{{ item.plot }}</desc>
{%- endif %}
{%- if item and item.year %}
    <date>{{ item.year }}</date>
{%- endif %}
{%- if item %}
{%- for genre in item.genre_names %}
    <category>{{ genre }}</category>
{%- endfor %}
{%- endif %}
{%- if item and item.xmltv_episode_num %}
    <episode-num system="xmltv_ns">{{ item.xmltv_episode_num }}</episode-num>
{%- endif %}
{%- if item and item.artwork_url %}
    <icon src="{{ item.artwork_url }}" />
{%- endif %}
  </programme>`;

const MUSIC_VIDEO_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
    <title>{{ title }}</title>
{%- if item and item.show_title %}
    <sub-title>{{ item.title }}</sub-title>
{%- endif %}
{%- if item and item.plot %}
    <desc>{{ item.plot }}</desc>
{%- endif %}
{%- if item and item.year %}
    <date>{{ item.year }}</date>
{%- endif %}
{%- if item %}
{%- for genre in item.genre_names %}
    <category>{{ genre }}</category>
{%- endfor %}
{%- endif %}
{%- if item and item.xmltv_episode_num %}
    <episode-num system="xmltv_ns">{{ item.xmltv_episode_num }}</episode-num>
{%- endif %}
{%- if item and item.artwork_url %}
    <icon src="{{ item.artwork_url }}" />
{%- endif %}
  </programme>`;

const OTHER_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
    <title>{{ title }}</title>
{%- if item and item.show_title %}
    <sub-title>{{ item.title }}</sub-title>
{%- endif %}
{%- if item and item.plot %}
    <desc>{{ item.plot }}</desc>
{%- endif %}
{%- if item and item.year %}
    <date>{{ item.year }}</date>
{%- endif %}
{%- if item %}
{%- for genre in item.genre_names %}
    <category>{{ genre }}</category>
{%- endfor %}
{%- endif %}
{%- if item and item.xmltv_episode_num %}
    <episode-num system="xmltv_ns">{{ item.xmltv_episode_num }}</episode-num>
{%- endif %}
{%- if item and item.artwork_url %}
    <icon src="{{ item.artwork_url }}" />
{%- endif %}
  </programme>`;

const FILLER_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
    <title>{{ title }}</title>
{%- if item and item.show_title %}
    <sub-title>{{ item.title }}</sub-title>
{%- endif %}
{%- if item and item.plot %}
    <desc>{{ item.plot }}</desc>
{%- endif %}
{%- if item and item.year %}
    <date>{{ item.year }}</date>
{%- endif %}
{%- if item %}
{%- for genre in item.genre_names %}
    <category>{{ genre }}</category>
{%- endfor %}
{%- endif %}
    <category>Filler</category>
{%- if item and item.xmltv_episode_num %}
    <episode-num system="xmltv_ns">{{ item.xmltv_episode_num }}</episode-num>
{%- endif %}
{%- if item and item.artwork_url %}
    <icon src="{{ item.artwork_url }}" />
{%- endif %}
  </programme>`;

const DEAD_AIR_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
    <title>No programming</title>
    <category>No programming</category>
  </programme>`;

const BLOCK_SOURCE = `{% comment %}
Available values:
  - kind
  - title (listing title used by the standard layout)
  - start / stop (XMLTV timestamps)
  - start_iso / stop_iso
  - channel.id, channel.number, channel.name, channel.logo_url
  - item (media metadata, or null)
  - item.kind, item.title, item.show_title, item.plot, item.year, item.genre_names
  - item.season_number, item.episode_number, item.xmltv_episode_num, item.artwork_url
  - item.artists, item.artist_names, item.album_names, item.track_number, item.directors
  - item.release_date, item.rating, item.actors, item.availability
  - slot.start, slot.finish, slot.role, slot.title, slot.program_id, slot.truncated
  - block.title, block.description (block listings only)

Interpolated text is escaped for XML. Blank tabs fall back to this built-in source.
{% endcomment %}
  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">
    <title>{{ title }}</title>
{%- if block and block.description %}
    <desc>{{ block.description }}</desc>
{%- endif %}
  </programme>`;

/** Built-in, read-only XMLTV layout that reproduces the current feed. */
export const BUILTIN_GUIDE_TEMPLATE = {
	id: BUILTIN_GUIDE_TEMPLATE_ID,
	name: 'Standard XMLTV',
	description: 'The current Moirai XMLTV channel and programme layout.',
	sources: {
		channel: CHANNEL_SOURCE,
		episode: EPISODE_SOURCE,
		movie: MOVIE_SOURCE,
		'music-video': MUSIC_VIDEO_SOURCE,
		other: OTHER_SOURCE,
		filler: FILLER_SOURCE,
		'dead-air': DEAD_AIR_SOURCE,
		block: BLOCK_SOURCE,
	} satisfies GuideTemplateSources,
};
