import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { channelCreateSchema, type ScheduleGuide, type SchedulingCatalog } from '@moirai/shared';
import { BUILTIN_GUIDE_TEMPLATE } from '@moirai/shared';
import { buildXmltv, effectiveTvgId, minifyXmltv, presentGuideListings, previewGuideListings, xmltvTimestamp } from '@server/guide/epg.js';

const builtinXmltv = {
	sourcesForChannel: () => BUILTIN_GUIDE_TEMPLATE.sources,
	fallback: true,
};

function catalog(): SchedulingCatalog {
	const showId = randomUUID();
	const seasonId = randomUUID();
	return {
		media: [
			{
				id: 'c84419f8-6019-4550-b704-c0711adf1dc9',
				libraryId: randomUUID(),
				groupId: seasonId,
				kind: 'episode',
				title: 'The <Arrival> & Return',
				sortTitle: 'arrival return',
				playbackPath: '/media/arrival.mkv',
				durationSeconds: 3600,
				seasonNumber: 2,
				episodeNumber: 3,
				genres: ['science-fiction'],
				genreNames: ['Science Fiction'],
				plot: 'A ship arrives & changes everything.',
				year: 2026,
				artworkUrl: '/api/v1/artwork/items/c84419f8-6019-4550-b704-c0711adf1dc9?v=poster',
				availability: 'available',
			},
		],
		groupParents: { [showId]: null, [seasonId]: showId },
		groupTitles: { [showId]: 'Example Show', [seasonId]: 'Season 2' },
		libraryNames: {},
		libraryAvailability: {},
	};
}

function guide(channelId: string, mediaId: string): ScheduleGuide {
	return {
		timeZone: 'America/Los_Angeles',
		startDate: '2026-11-01',
		requestedDays: 1,
		days: 1,
		segmentLimitApplied: false,
		channels: [
			{
				channelId,
				preview: {
					channelId,
					timeZone: 'America/Los_Angeles',
					startDate: '2026-11-01',
					days: 1,
					segments: [
						{
							id: randomUUID(),
							role: 'primary',
							channelId,
							scheduleLayerId: null,
							templateId: randomUUID(),
							slotId: randomUUID(),
							programId: randomUUID(),
							mediaItemId: mediaId,
							title: 'The <Arrival> & Return',
							playbackPath: '/media/arrival.mkv',
							start: '2026-11-01T08:30:00Z',
							finish: '2026-11-01T09:30:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: null,
							truncated: false,
						},
						{
							id: randomUUID(),
							role: 'dead-air',
							channelId,
							scheduleLayerId: null,
							templateId: randomUUID(),
							slotId: randomUUID(),
							programId: null,
							mediaItemId: null,
							title: 'Dead air',
							playbackPath: null,
							start: '2026-11-01T09:30:00Z',
							finish: '2026-11-01T10:00:00Z',
							sourceStartSeconds: 0,
							sourceFinishSeconds: null,
							truncated: false,
						},
					],
					issues: [],
					proposedState: [],
				},
			},
		],
	};
}

describe('XMLTV EPG', () => {
	it('formats each instant with the correct DST offset', () => {
		expect(xmltvTimestamp('2026-11-01T08:30:00Z', 'America/Los_Angeles')).toBe(
			'20261101013000 -0700',
		);
		expect(xmltvTimestamp('2026-11-01T09:30:00Z', 'America/Los_Angeles')).toBe(
			'20261101013000 -0800',
		);
	});

	it('keeps a still-playing programme that started before the guide day', async () => {
		const channel = {
			...channelCreateSchema.parse({ number: '4', name: 'Overnight' }),
			id: randomUUID(),
			createdAt: '2026-11-01T00:00:00Z',
			updatedAt: '2026-11-01T00:00:00Z',
		};
		const source = catalog();
		const output = guide(channel.id, source.media[0]!.id);
		const start = '2026-10-31T23:00:00Z';
		const finish = '2026-11-01T01:30:00Z';
		output.channels[0]!.preview.segments[0] = {
			...output.channels[0]!.preview.segments[0]!,
			start,
			finish,
		};
		const xml = await buildXmltv([channel], output, source, 'https://moirai.example.test', builtinXmltv);

		expect(xml).toContain(`start="${xmltvTimestamp(start, output.timeZone)}"`);
		expect(xml).toContain(`stop="${xmltvTimestamp(finish, output.timeZone)}"`);
		expect(xml).toContain('<title>The &lt;Arrival&gt; &amp; Return (2.3)</title>');
	});

	it('emits rich episode metadata, proxied artwork, and explicit no-programming entries', async () => {
		const channel = {
			...channelCreateSchema.parse({
				number: '7',
				name: 'Example & More',
				logo: 'https://images.example.test/channel.png?size=large&v=old',
			}),
			id: '3a9bb80f-e7a0-4fa9-ad69-e67e92473e25',
			createdAt: '2026-08-21T00:00:00Z',
			updatedAt: '2026-08-21T00:00:00Z',
		};
		const source = catalog();
		const xml = await buildXmltv(
			[channel],
			guide(channel.id, source.media[0]!.id),
			source,
			'https://moirai.example.test',
			builtinXmltv,
		);

		expect(() => new XMLParser({ ignoreAttributes: false }).parse(xml)).not.toThrow();
		expect(effectiveTvgId(channel)).toBe('C7.3a9bb80f.moirai.tv');
		expect(xml).toContain('<channel id="C7.3a9bb80f.moirai.tv">');
		expect(xml).toContain('<display-name>Example &amp; More</display-name>');
		expect(xml).toContain(
			'src="https://images.example.test/channel.png?size=large&amp;v=2026-08-21T00%3A00%3A00Z"',
		);
		expect(xml).toContain('<title>The &lt;Arrival&gt; &amp; Return (2.3)</title>');
		expect(xml).toContain('<sub-title>Example Show</sub-title>');
		expect(xml).toContain('<episode-num system="xmltv_ns">1.2.</episode-num>');
		expect(xml).toContain('<category>Science Fiction</category>');
		expect(xml).toContain('src="https://moirai.example.test/api/v1/artwork/items/');
		expect(xml).toContain('v=poster&amp;variant=compat&amp;dpr=3');
		expect(xml).toContain('<title>No programming</title>');
	});
});

it('publishes custom block metadata without leaking individual episode metadata', async () => {
	const channel = { ...channelCreateSchema.parse({ number: '8', name: 'Music' }),
		id: randomUUID(), createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
	const source = catalog();
	const output = guide(channel.id, source.media[0]!.id);
	output.channels[0]!.entries = [{
		id: 'block', kind: 'block', channelId: channel.id, start: '2026-11-01T08:00:00Z', finish: '2026-11-01T09:00:00Z',
		title: 'Rock & Roll', description: 'Music <all> hour', programId: null, segmentId: null, occurrenceId: 'occurrence',
		role: 'primary', truncated: false,
	}];
	const xml = await buildXmltv([channel], output, source, 'https://moirai.example.test', builtinXmltv);
	const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
	expect(parsed.tv.programme).toEqual({
		title: 'Rock & Roll', desc: 'Music <all> hour', '@_channel': effectiveTvgId(channel),
		'@_start': '20261101010000 -0700', '@_stop': '20261101010000 -0800',
	});
});

it('minifies published XMLTV without changing preview formatting', async () => {
	const channel = {
		...channelCreateSchema.parse({ number: '9', name: 'Minify' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	const preview = await buildXmltv(
		[channel],
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		builtinXmltv,
	);
	const published = await buildXmltv(
		[channel],
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		{ ...builtinXmltv, minify: true },
	);
	expect(preview).toContain('\n  <channel');
	expect(preview).not.toContain('Available values');
	expect(preview).not.toContain('{#');
	expect(published).not.toMatch(/>\s+</u);
	expect(published).not.toContain('Available values');
	expect(minifyXmltv(preview)).toBe(published);
	expect(published).toContain('<title>The &lt;Arrival&gt; &amp; Return (2.3)</title>');
});

it('keeps programme tabs isolated and falls back to the built-in source for other kinds', async () => {
	const channel = {
		...channelCreateSchema.parse({ number: '10', name: 'Custom' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	const xml = await buildXmltv(
		[channel],
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		{
			sourcesForChannel: () => ({
				...BUILTIN_GUIDE_TEMPLATE.sources,
				episode: '  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}"><title>Custom {{ title }}</title></programme>',
			}),
			fallback: true,
		},
	);
	expect(xml).toContain('<title>Custom Example Show</title>');
	expect(xml).toContain('<title>No programming</title>');
	expect(xml).not.toContain('Custom No programming');
});

it('falls back to the built-in episode layout when live Liquid is invalid', async () => {
	const warnings: string[] = [];
	const channel = {
		...channelCreateSchema.parse({ number: '11', name: 'Fallback' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	const xml = await buildXmltv(
		[channel],
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		{
			sourcesForChannel: () => ({
				...BUILTIN_GUIDE_TEMPLATE.sources,
				episode: '{% invalid %}',
			}),
			fallback: true,
			warn: (message) => warnings.push(message),
		},
	);
	expect(xml).toContain('<title>The &lt;Arrival&gt; &amp; Return (2.3)</title>');
	expect(warnings.length).toBeGreaterThan(0);
});

it('overlays XMLTV titles onto a one-day preview guide', async () => {
	const channel = {
		...channelCreateSchema.parse({ number: '12', name: 'Preview' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	const preview = await previewGuideListings(
		channel,
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		{
			...BUILTIN_GUIDE_TEMPLATE.sources,
			episode: '  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}"><title>On-air {{ title }}</title></programme>',
		},
	);
	expect(preview.entries.map((entry) => entry.title)).toContain('On-air Example Show');
	expect(preview.entries.map((entry) => entry.title)).toContain('No programming');
	expect(preview.channelValues).toEqual(expect.arrayContaining([
		expect.objectContaining({ name: 'channel.name', value: 'Preview' }),
	]));
	const episode = preview.entries.find((entry) => entry.title === 'On-air Example Show');
	expect(preview.listingValues[episode!.id]).toEqual(expect.arrayContaining([
		expect.objectContaining({ name: 'item.kind', value: 'episode' }),
		expect.objectContaining({ name: 'item.title', value: 'The <Arrival> & Return' }),
		expect.objectContaining({ name: 'item.show_title', value: 'Example Show' }),
	]));
});

it('presents committed guide listings using each channel template', async () => {
	const channel = {
		...channelCreateSchema.parse({ number: '13', name: 'Guide' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	const output = guide(channel.id, source.media[0]!.id);
	const presented = await presentGuideListings(
		[channel],
		output,
		source,
		'https://moirai.example.test',
		{
			sourcesForChannel: () => ({
				...BUILTIN_GUIDE_TEMPLATE.sources,
				episode: '  <programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}"><title>Guide {{ title }}</title><sub-title>{{ item.title }}</sub-title></programme>',
			}),
			fallback: true,
		},
	);
	expect(output.channels[0]!.preview.segments[0]!.title).toBe('The <Arrival> & Return');
	expect(presented.channels[0]!.preview.segments.map((segment) => segment.title)).toContain('Guide Example Show');
	expect(presented.channels[0]!.preview.segments.map((segment) => segment.title)).toContain('No programming');
	expect(presented.channels[0]!.preview.segments.find((segment) => segment.title === 'Guide Example Show')?.subtitle).toBe('The <Arrival> & Return');
	expect(presented.channels[0]!.preview.segments.find((segment) => segment.title === 'Guide Example Show')?.posterUrl)
		.toBe(source.media[0]!.artworkUrl);
});

it('copies live fanart onto presented listings', async () => {
	const channel = {
		...channelCreateSchema.parse({ number: '13', name: 'Guide' }),
		id: randomUUID(),
		createdAt: '2026-11-01T00:00:00Z',
		updatedAt: '2026-11-01T00:00:00Z',
	};
	const source = catalog();
	source.media[0] = {
		...source.media[0]!,
		fanartUrl: '/api/v1/artwork/items/c84419f8-6019-4550-b704-c0711adf1dc9?v=fanart&role=fanart',
	};
	const presented = await presentGuideListings(
		[channel],
		guide(channel.id, source.media[0]!.id),
		source,
		'https://moirai.example.test',
		builtinXmltv,
	);
	expect(presented.channels[0]!.preview.segments.find((segment) => segment.mediaItemId === source.media[0]!.id)?.fanartUrl)
		.toBe(source.media[0]!.fanartUrl);
});
