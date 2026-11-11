import { graphicsPresets, materializedTimelineSegments } from '@server/db/schema.js';
import { prepareGraphicsContexts } from '@server/graphics/context.js';
import { graphicsPreparationBudget, preparePlayoutGraphicsLabels } from '@server/graphics/segments.js';
import type { GraphicsClock } from '@server/graphics/clock.js';
import { resolveGraphicsPreviewPosition } from '@server/graphics/preview-context.js';
import { buildXmltv } from '@server/guide/epg.js';
import { getGraphicsSampleClip } from '@server/graphics/sample-clip.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { BUILTIN_GUIDE_TEMPLATE, channelCreateSchema, channelScheduleConfigSchema, programCreateSchema, resolveGraphicsGeometry, scheduleTemplateCreateSchema, type SchedulableMedia, type TimelineSegment } from '@moirai/shared';
import { ETV_PLAYOUT_VERSION } from '@moirai/ersatztv-contract';
import { applyNextMigration, readMigrationJournal } from '@server/db/migrations.js';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { loadConfig } from '@server/config.js';
import { graphicsAssetPath, graphicsFolder, publishGraphicsFile, removeGraphicsOriginal, runGraphicsProcess, storeGraphicsAsset } from '@server/graphics/assets.js';
import { GRAPHICS_SNAPSHOT_LIMIT, GraphicsSnapshotBusyError, GraphicsSnapshots } from '@server/graphics/snapshots.js';
import { graphicsFontFamily } from '@server/graphics/font-family.js';
import { graphicsExamples, exampleGraphicsAssets } from '@server/graphics/examples.js';
import { parseGraphics } from '@server/graphics/document.js';
import { resolveGraphicsPresets, selectGraphicsSegments } from '@server/graphics/segments.js';
import { graphicsPresetIds } from '@server/graphics/segments.js';
import { decorateGraphics } from '@server/graphics/playout.js';
import { graphicsPreviewExecutable, graphicsPreviewOpacity, renderGraphicsPreview, renderGraphicsSampleClip } from '@server/graphics/preview.js';
import { createBoundedLiquid } from '@server/liquid-template.js';
import { transformedGraphics } from '@server/graphics/transforms.js';
import * as graphicsRendering from '@server/graphics/render.js';
import { graphicsContexts, graphicsTiming, prepareGraphicsLayer, sampleGraphicsContext } from '@server/graphics/render.js';

/** Keep geometry fixtures independent of protected preset designs. */
const shapedFixture = parseGraphics(JSON.stringify({ version: 1, layers: [{
	id: randomUUID(), kind: 'shape', anchor: 'bottom_left', horizontalMargin: 4, verticalMargin: 5, opacity: 70,
	withinSource: true, timing: { mode: 'always' }, width: 34,
	shape: { primitive: 'roundedRectangle', width: 652, height: 110, radius: 18, fill: '#103C36', stroke: '#8DE7FF', strokeWidth: 2 },
}, {
	id: randomUUID(), kind: 'text', anchor: 'bottom_left', horizontalMargin: 5, verticalMargin: 7, opacity: 100,
	withinSource: true, timing: { mode: 'always' }, text: '{{ next.title | default: "Schedule to be announced" }}',
	style: { size: 42, color: '#FFFFFF' },
}] }));

/** Run the graphics repository against the actual migrations and isolated managed files. */
async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-graphics-test-'));
	const database = createDatabase(':memory:', 'drizzle');
	return {
		root,
		db: database.db,
		repository: new Repository(database.db),
		async close() {
			database.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Make committed primary and roll segments for the graphics preparation boundary. */
function segment(start: number, finish: number, overrides: Partial<TimelineSegment> = {}): TimelineSegment {
	return {
		id: randomUUID(), channelId: randomUUID(), scheduleLayerId: null, templateId: randomUUID(), slotId: randomUUID(),
		role: 'primary', programId: null, mediaItemId: null, title: 'Main Feature', playbackPath: '/media/feature.mp4',
		start: new Date(start).toISOString(), finish: new Date(finish).toISOString(),
		sourceStartSeconds: 0, sourceFinishSeconds: null, truncated: false, ...overrides,
	};
}

it('uses the channel guide item labels for split airings and raw snapshot metadata for the playing clip', async () => {
	const state = await fixture();
	try {
		const { repository } = state;
		const base = '<programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}">';
		const assigned = await repository.guideTemplates.save({ name: 'Overlay labels', description: '', sources: {
			...BUILTIN_GUIDE_TEMPLATE.sources,
			episode: base + '<title>{{ item.show_title }} &#38; Friends</title><sub-title>{{ item.title }} <![CDATA[& Beyond]]></sub-title></programme>',
			movie: base + '<title>{{ item.title }} Premiere</title></programme>',
		} });
		const channel = await repository.createChannel(channelCreateSchema.parse({
			name: 'Alpine TV', number: '72.2', guideTemplateId: assigned.id, graphicsPresetId: graphicsExamples[1]!.id,
		}));
		const start = Date.now() + 30_000;
		const rule = { type: 'content', source: { type: 'library-query', libraryId: randomUUID(), filter: {} },
			strategy: { type: 'sequential' } } as const;
		const primaryProgram = await repository.createProgram(programCreateSchema.parse({ name: 'Main feature', config: rule,
			metadata: { showcase_actor: 'A & <B>' },
		}));
		const fillerProgram = await repository.createProgram(programCreateSchema.parse({ name: 'Interstitials', config: rule,
			metadata: { showcase_actor: 'Station' },
		}));
		const nextProgram = await repository.createProgram(programCreateSchema.parse({ name: 'Next feature', config: rule,
			metadata: { showcase_actor: 'C' },
		}));
		const episodeId = randomUUID();
		const fillerId = randomUUID();
		const movieId = randomUUID();
		const primary = segment(start, start + 1000, { channelId: channel.id, mediaItemId: episodeId, title: 'Committed Title', programId: primaryProgram.id });
		const airing = { id: randomUUID(), primarySegmentId: primary.id, start: primary.start,
			finish: new Date(start + 3000).toISOString(), truncated: false };
		primary.airing = airing;
		const attached = segment(start + 1000, start + 2000, { channelId: channel.id, role: 'filler', mediaItemId: fillerId, airing, programId: fillerProgram.id });
		const split = segment(start + 2000, start + 3000, { ...primary, id: randomUUID(),
			start: new Date(start + 2000).toISOString(), finish: airing.finish });
		const gap = segment(start + 3000, start + 4000, { role: 'dead-air' });
		const standalone = segment(start + 4000, start + 5000, { channelId: channel.id, role: 'filler', mediaItemId: fillerId });
		const future = segment(start + 5000, start + 6000, { channelId: channel.id, mediaItemId: movieId, title: 'Committed Movie', programId: nextProgram.id });
		const spans = [primary, attached, split, gap, standalone, future];
		const makeMedia = (id: string, kind: string, title: string): SchedulableMedia => ({
			id, kind, title, sortTitle: title, libraryId: randomUUID(), groupId: null, playbackPath: '/private/catalog.mp4',
			durationSeconds: 600, seasonNumber: null, episodeNumber: null, genres: [], genreNames: [],
			plot: null, year: null, artworkUrl: null, availability: 'available',
		});
		const episode = { ...makeMedia(episodeId, 'episode', 'Raw Episode'), seriesTitle: 'Alpine Series',
			seasonNumber: 1, episodeNumber: 2, episodeEndNumber: 3, plot: 'Catalog synopsis' };
		const filler = makeMedia(fillerId, 'other', 'Station Ident');
		const movie = makeMedia(movieId, 'movie', 'Raw Movie');
		const snapshots = vi.spyOn(repository, 'timelineMediaSnapshots').mockResolvedValue(new Map([[primary.id, episode], [split.id, episode]]));
		const catalog = { media: [filler, movie], groupParents: {}, groupTitles: {}, libraryAvailability: {}, libraryNames: {} };
		const catalogRead = vi.spyOn(repository, 'getSchedulingCatalogForItems').mockResolvedValue(catalog);
		vi.spyOn(repository, 'listMaterializedTimelineSegments').mockResolvedValue(spans.map(item => ({
			segment: item, mediaSnapshot: null, stateDelta: [],
		})));
		const zone = 'Asia/Kolkata';
		const publicUrl = 'https://moirai.example.test';
		const contexts = await prepareGraphicsContexts(repository, channel, spans, [attached, split, standalone], zone, publicUrl);
		const inRoll = contexts.get(attached.id)!;
		expect(inRoll).toMatchObject({
			channel: { name: 'Alpine TV', number: '72.2' }, media: { title: 'Station Ident', subtitle: null },
			program: { metadata: { showcase_actor: 'Station' } },
			now: { program: { metadata: { showcase_actor: 'A & <B>' } }, title: 'Alpine Series & Friends', subtitle: 'Raw Episode & Beyond', start: primary.start, finish: airing.finish,
				media: { title: 'Raw Episode', episodeEndNumber: 3, description: 'Catalog synopsis' } },
			next: { program: { metadata: { showcase_actor: 'C' } }, title: 'Raw Movie Premiere', subtitle: null, media: { title: 'Raw Movie' } },
		});
		expect(inRoll.next).toBe(inRoll.upcoming[0]);
		expect(contexts.get(split.id)?.now).toEqual(inRoll.now);
		expect(contexts.get(standalone.id)).toMatchObject({ now: null, next: inRoll.next });
		expect(inRoll.next?.startTime).toBe(new Intl.DateTimeFormat('en-GB', { timeZone: zone,
			hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start + 5000));
		expect(catalogRead).toHaveBeenCalledTimes(1);
		expect(catalogRead).toHaveBeenCalledWith(expect.arrayContaining([fillerId, movieId]));
		expect(JSON.stringify(inRoll)).not.toContain('/private/');

		const guide = {
			startDate: primary.start.slice(0, 10), days: 1, timeZone: zone,
			channels: [{ channelId: channel.id, preview: { segments: [primary, split] } }],
		} as Parameters<typeof buildXmltv>[1];
		const xml = await buildXmltv([channel], guide, { ...catalog, media: [episode] }, publicUrl, {
			sourcesForChannel: () => assigned.sources,
		});
		expect(xml).toContain('<title>Alpine Series &#38; Friends</title><sub-title>Raw Episode <![CDATA[& Beyond]]></sub-title>');
		guide.channels[0]!.entries = [{
			id: randomUUID(), kind: 'block', channelId: channel.id, start: primary.start, finish: airing.finish,
			title: 'Evening Block', description: '', segmentId: null, occurrenceId: randomUUID(),
			role: 'primary', programId: null, truncated: false, posterUrl: null, landscapeUrl: null, fanartUrl: null,
		}];
		const grouped = await buildXmltv([channel], guide, { ...catalog, media: [episode] }, publicUrl, {
			sourcesForChannel: () => assigned.sources,
		});
		expect(grouped).toContain('<title>Evening Block</title>');
		const selected = await resolveGraphicsPreviewPosition(repository, channel, 1500, zone, publicUrl);
		expect(selected.preview).toEqual({ availability: 'available', context: inRoll });
		const inGap = await resolveGraphicsPreviewPosition(repository, channel, 3500, zone, publicUrl);
		expect(inGap.preview).toEqual({ availability: 'gap', context: { channel: inRoll.channel, media: null, now: null, next: null, upcoming: [] } });

		const { contexts: labels } = (await preparePlayoutGraphicsLabels(repository, channel, spans, zone, publicUrl, 1000))!;
		expect(labels?.get(split.id)?.now).toEqual(inRoll.now);
		const text = shapedFixture.layers[1]!;
		if (text.kind !== 'text') {
			throw new Error('Expected a text layer');
		}
		const snapshot = await GraphicsSnapshots.open(path.join(state.root, 'snapshots'));
		const missingSize = { ...text, text: '{{ now.program.metadata.size }}' };
		expect(await prepareGraphicsLayer(state.root, missingSize, new Map(), inRoll, 1000, snapshot, channel.video)).toBeNull();
		const layer = { ...text, text: '{{ now.program.metadata.showcase_actor }}' };
		expect(await prepareGraphicsLayer(state.root, layer, new Map(), inRoll, 1000, snapshot, channel.video)).not.toBeNull();
		await repository.updateProgram(primaryProgram.id, { metadata: { showcase_actor: 'Updated' } });
		await repository.guideTemplates.save({ name: assigned.name, description: '', sources: {
			...assigned.sources, episode: base + '<title></title></programme>',
		} }, assigned.id);
		const { contexts: refreshed } = (await preparePlayoutGraphicsLabels(repository, channel, spans, zone, publicUrl, 1000))!;
		expect(refreshed?.get(split.id)?.now).toMatchObject({ title: 'Committed Title', subtitle: null, program: { metadata: { showcase_actor: 'Updated' } } });
		await repository.guideTemplates.setDefault(assigned.id);
		const unassigned = { ...channel, guideTemplateId: null };
		const defaults = await prepareGraphicsContexts(repository, unassigned, spans, [split], zone, publicUrl);
		expect(defaults.get(split.id)?.now).toEqual(refreshed?.get(split.id)?.now);

		snapshots.mockClear();
		await preparePlayoutGraphicsLabels(repository, { ...channel, graphicsPresetId: graphicsExamples[0]!.id }, spans, zone, publicUrl, 1000);
		expect(snapshots).not.toHaveBeenCalled();
		const delayed = await preparePlayoutGraphicsLabels(repository, channel, spans, zone, publicUrl, 0);
		expect(delayed?.contexts?.size).toBe(0);
		const readMetadata = repository.programMetadataForIds.bind(repository);
		let budget = graphicsPreparationBudget.live;
		vi.spyOn(repository, 'programMetadataForIds').mockImplementationOnce(async ids => {
			const result = await readMetadata(ids);
			budget = 0;
			return result;
		});
		const expired = await preparePlayoutGraphicsLabels(repository, channel, spans, zone, publicUrl, () => budget);
		expect(expired?.contexts?.size).toBe(0);
		expect(expired?.segments.some(item => item.id === primary.id)).toBe(true);
	}
	finally {
		await state.close();
	}
});

it('recovers the committed primary label for a post-roll in the next broadcast day', async () => {
	const state = await fixture();
	try {
		const { repository, db } = state;
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '4', name: 'Overnight' }));
		const midnight = Date.parse('2026-11-05T00:00:00Z');
		const primary = segment(midnight - 10_000, midnight - 2000, { channelId: channel.id, title: 'Late feature' });
		const airing = { id: randomUUID(), primarySegmentId: primary.id, start: primary.start,
			finish: new Date(midnight + 3000).toISOString(), truncated: false };
		primary.airing = airing;
		const postRoll = segment(midnight - 2000, midnight + 3000, { channelId: channel.id, role: 'filler', airing });
		const next = segment(midnight + 3000, midnight + 9000, { channelId: channel.id, title: 'After midnight' });
		await db.insert(materializedTimelineSegments).values([primary, postRoll, next].map(span => ({
			id: span.id, channelId: span.channelId, role: span.role, title: span.title, airing: span.airing,
			templateId: span.templateId, slotId: span.slotId, startsAt: span.start, finishesAt: span.finish,
			sourceStartSeconds: 0, truncated: false, stateDelta: [],
		})));

		const rows = await repository.listMaterializedTimelineSegments(new Date(midnight).toISOString(), next.finish, channel.id);
		const spans = rows.map(row => row.segment);
		expect(spans.map(span => span.id)).toEqual([postRoll.id, next.id]);
		const contexts = await prepareGraphicsContexts(repository, channel, spans, spans, 'UTC', 'http://localhost');
		expect(contexts.get(postRoll.id)).toMatchObject({
			now: { title: 'Late feature', start: primary.start, finish: airing.finish },
			next: { title: 'After midnight' },
		});
		expect(contexts.get(next.id)?.upcoming).toEqual([]);
	}
	finally {
		await state.close();
	}
});

describe('channel graphics', () => {
	it('offers stable protected examples, preserves YAML, and rejects deleting an assigned copy', async () => {
		const state = await fixture();
		try {
			const { repository } = state;
			expect(repository.graphics.list()).toEqual(graphicsExamples);
			expect(() => repository.graphics.delete(graphicsExamples[0]!.id)).toThrow(/protected/);
			const yaml = `# Keep this comment\n${graphicsExamples[0]!.yaml}`;
			const draft = repository.graphics.save({ name: 'My Watermark', yaml });
			expect(repository.graphics.get(draft.id)?.yaml).toBe(yaml);
			expect(() => repository.graphics.save({ name: 'MY WATERMARK', yaml })).toThrow(/already exists/);
			for (const name of ['Live Clock', 'Upcoming Ticker']) {
				const nameKey = name.toLowerCase();
				expect(() => repository.graphics.save({ name: nameKey, yaml })).toThrow(/reserved/);
				expect(() => repository.graphics.save({ name, yaml }, draft.id)).toThrow(/reserved/);

				const legacyId = randomUUID();
				await state.db.insert(graphicsPresets).values({ id: legacyId, name, nameKey, yaml });
				const updated = repository.graphics.save({ name, yaml: `# Edited legacy preset\n${yaml}` }, legacyId);
				expect(repository.graphics.get(legacyId)).toEqual(updated);
				expect(repository.graphics.list().filter(preset => preset.name === name)).toHaveLength(2);
				expect(() => repository.graphics.save({ name: nameKey, yaml }, legacyId)).toThrow(/reserved/);
			}
			const channel = await repository.createChannel(channelCreateSchema.parse({ number: '42', name: 'Test TV' }));
			expect(channel.graphicsPresetId).toBeUndefined();
			await expect(repository.updateChannel(channel.id, { graphicsPresetId: randomUUID() })).rejects.toThrow(/does not exist/);
			await repository.updateChannel(channel.id, { graphicsPresetId: draft.id });
			expect(() => repository.graphics.delete(draft.id)).toThrow(/assigned/i);
			await repository.updateChannel(channel.id, { graphicsPresetId: null });
			repository.graphics.delete(draft.id);
			expect(repository.graphics.get(draft.id)).toBeUndefined();
		}
		finally {
			await state.close();
		}
	});

	it('persists scoped assignments and resolves different stacks for primary content and filler', async () => {
		const state = await fixture();
		try {
			const { repository } = state;
			const [watermark, lowerThird, channelId, animated, shaped] = graphicsExamples;
			const saved = repository.graphics.save({ name: 'Custom overlay', yaml: shaped!.yaml });
			const channel = await repository.createChannel(channelCreateSchema.parse({ number: '8', name: 'Station', graphicsPresetId: watermark!.id }));
			const add = (presetId: string) => ({ mode: 'add' as const, presetId });
			const programInput = programCreateSchema.parse({ name: 'Main', config: { type: 'content', source: {
				type: 'library-query', libraryId: randomUUID(), filter: {},
			}, strategy: { type: 'sequential' }, graphicsAssignment: add(lowerThird!.id) } });
			const program = await repository.createProgram(programInput);
			const fillerProgram = await repository.createProgram({ ...programInput, name: 'Bumpers', config: { ...programInput.config, graphicsAssignment: add(animated!.id) } });
			const filler = (await repository.fillerPresets.save({ kind: 'pre-roll', name: 'Branded break', description: '',
				budget: { type: 'count', count: 1 }, graphicsAssignment: add(saved.id) })).preset;
			const slotId = randomUUID();
			const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Day',
				graphicsAssignment: add(channelId!.id), slots: [{ id: slotId, startSeconds: 0, programId: program.id, graphicsAssignment: add(watermark!.id) }],
				boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }] }));
			await repository.setChannelSchedule(channel.id, channelScheduleConfigSchema.parse({ defaultTemplateId: template.id, graphicsAssignment: { mode: 'off' } }));
			const primary = segment(0, 5000, { programId: program.id, templateId: template.id, slotId });
			const roll = segment(5000, 6000, { role: 'filler', programId: fillerProgram.id, templateId: template.id, slotId, fillerPresetId: filler.id });
			const assignments = repository.graphics.assignments({ channelId: channel.id, segments: [primary, roll] });
			expect(resolveGraphicsPresets(channel, primary, assignments).map(preset => preset.id)).toEqual([channelId!.id, lowerThird!.id, watermark!.id]);
			expect(selectGraphicsSegments([primary, roll], channel, assignments)[1]?.presets).toEqual([
				{ id: channelId!.id, text: false }, { id: watermark!.id, text: false },
				{ id: animated!.id, text: true }, { id: saved.id, text: true },
			]);
			const fallback = segment(6000, 7000, {
				role: 'filler', programId: fillerProgram.id, mediaItemId: randomUUID(), templateId: template.id, slotId,
			});
			const fallbackAssignments = repository.graphics.assignments({ channelId: channel.id, segments: [fallback] });
			expect(selectGraphicsSegments([fallback], channel, fallbackAssignments)[0]?.presets).toEqual([
				{ id: channelId!.id, text: false }, { id: watermark!.id, text: false }, { id: animated!.id, text: true },
			]);
			expect(() => repository.graphics.delete(saved.id)).toThrow(/assigned/i);
			await expect(repository.updateProgram(program.id, { config: { ...program.config, graphicsAssignment: add(randomUUID()) } })).rejects.toThrow(/does not exist/);
			await repository.updateScheduleTemplate(template.id, { slots: [{ ...template.slots[0]!, graphicsAssignment: { mode: 'replace', presetId: lowerThird!.id } }] });
			const primaryAssignments = repository.graphics.assignments({ channelId: channel.id, segments: [primary] });
			expect(primaryAssignments.has(`filler:${filler.id}`)).toBe(false);
			expect(primaryAssignments.has(`program:${fillerProgram.id}`)).toBe(false);
			expect(resolveGraphicsPresets(channel, primary, primaryAssignments)).toEqual([{ id: lowerThird!.id, text: true }]);
		}
		finally {
			await state.close();
		}
	});

	it('upgrades a pre-graphics database without altering the saved channel or opting it in', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'moirai-graphics-upgrade-'));
		const filename = path.join(root, 'database.sqlite');
		const before = new Database(filename);
		const id = randomUUID();
		const authored = JSON.stringify(channelCreateSchema.parse({ number: '5', name: 'Existing station' }));
		try {
			const migrations = readMigrationJournal('drizzle');
			for (const entry of migrations) {
				if (entry.tag === '0043_graphics') {
					break;
				}
				applyNextMigration(before, 'drizzle');
			}
			before.prepare("INSERT INTO channels (id, number, number_key, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))").run(id, '5', '5', 'Existing station', authored);
			before.close();

			const after = createDatabase(filename, 'drizzle');
			try {
				expect(after.sqlite.prepare('SELECT config FROM channels WHERE id = ?').get(id)).toEqual({ config: authored });
				const repository = new Repository(after.db);
				expect((await repository.getChannel(id))?.graphicsPresetId).toBeUndefined();
				expect(repository.graphics.list()).toEqual(graphicsExamples);
			}
			finally {
				after.close();
			}
		}
		finally {
			if (before.open) {
				before.close();
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects aliases and reports the location of an invalid layer field', () => {
		expect(() => parseGraphics('version: 1\nlayers: &layers [*layers]')).toThrow(/aliases/);
		expect(() => parseGraphics(graphicsExamples[0]!.yaml.replace('opacity: 70', 'opacity: 170'))).toThrow(/Line \d+, layers\.0\.opacity/);
	});

	it('publishes primary text and images, inherited images over filler media, and no graphics over dead air', async () => {
		const state = await fixture();
		try {
			const { repository, root } = state;
			const start = Date.now() + 60_000;
			const airingId = randomUUID();
			const primary = segment(start, start + 5000);
			const airing = { id: airingId, primarySegmentId: primary.id, start: primary.start, finish: new Date(start + 15_000).toISOString(), truncated: false };
			primary.airing = airing;
			const roll = segment(start + 5000, start + 10_000, { role: 'filler', fillerStage: 'mid-roll', airing });
			const second = segment(start + 10_000, start + 15_000, { airing });
			const next = segment(start + 15_000, start + 20_000, { title: 'Coming Up' });
			const fallback = segment(start + 20_000, start + 25_000, { role: 'filler', mediaItemId: randomUUID() });
			const gap = segment(start + 25_000, start + 30_000, { role: 'dead-air' });
			const segments = [primary, roll, second, next, fallback, gap];
			const text = shapedFixture.layers[1]!;
			const image = parseGraphics(graphicsExamples[0]!.yaml).layers[0]!;
			const yaml = `version: 1\nlayers: ${JSON.stringify([{ ...text, id: randomUUID() }, image])}`;
			const preset = repository.graphics.save({ name: 'Test graphics', yaml });
			const channel = await repository.createChannel(channelCreateSchema.parse({ number: '7', name: 'Test TV', graphicsPresetId: preset.id }));
			const contexts = graphicsContexts(channel, segments, 'Asia/Kolkata');
			expect(contexts.get(primary.id)?.next?.startTime).toBe(new Intl.DateTimeFormat('en-GB', {
				timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
			}).format(new Date(next.start)));
			expect(contexts.get(primary.id)?.next?.title).toBe(next.title);
			expect(contexts.get(second.id)?.now?.finish).toBe(airing.finish);
			expect(contexts.get(next.id)?.next).toBeNull();
			expect(contexts.get(primary.id)?.upcoming.map(programme => programme.title)).toEqual([next.title]);
			expect(contexts.get(second.id)?.upcoming).toEqual(contexts.get(primary.id)?.upcoming);
			expect(contexts.get(next.id)?.upcoming).toEqual([]);
			const document = parseGraphics(preset.yaml);
			const assets = repository.graphics.validateAssets(document);
			for (const context of contexts.values()) {
				for (const layer of document.layers) {
					await prepareGraphicsLayer(root, layer, assets, context, 5000, await GraphicsSnapshots.open(path.join(root, 'snapshots')), channel.video);
				}
			}
			const files = new Map([['day.json', JSON.stringify({
				version: ETV_PLAYOUT_VERSION,
				items: segments.map(span => ({
					id: `${span.id}:2026-10-02:1`, start: span.start, finish: span.finish,
					source: { source_type: 'local', path: span.playbackPath },
				})),
			})]]);
			const snapshots = await GraphicsSnapshots.open(path.join(root, 'snapshots'));
			const prepared = (await preparePlayoutGraphicsLabels(repository, channel, segments, 'UTC', 'http://localhost', 1000))!;
			const result = await decorateGraphics(root, prepared.presets, channel, prepared.segments, files, () => false, snapshots, undefined, 'UTC', undefined, prepared.contexts);
			expect(result.issue).toBeUndefined();
			const items = JSON.parse(result.files.get('day.json')!).items;
			expect(items[0].graphics.map((layer: { location: string }) => layer.location)).toEqual(['bottom_left', 'bottom_right']);
			expect(items[1].graphics.map((layer: { location: string }) => layer.location)).toEqual(['bottom_right']);
			expect(items[4].graphics.map((layer: { location: string }) => layer.location)).toEqual(['bottom_right']);
			expect(items[5].graphics).toBeUndefined();
			expect((await sharp(await readFile(items[0].graphics[0].source.path)).metadata()).hasAlpha).toBe(true);

			const delayed = await decorateGraphics(root, prepared.presets, channel, prepared.segments, files, () => true, snapshots, undefined, 'UTC', undefined, new Map());
			expect(delayed.issue).toMatch(/guide labels/i);
			const first = JSON.parse(delayed.files.get('day.json')!).items[0];
			expect(first.source.path).toBe(primary.playbackPath);
			expect(first.graphics.map((layer: { location: string }) => layer.location)).toEqual(['bottom_right']);
		}
		finally {
			await state.close();
		}
	});

	it('uses native cutoff and rejects unbounded periodic expansion', () => {
		expect(graphicsTiming({ mode: 'once', phase: 3000, fade: 1000, hold: 6000 }, 60_000)).toMatchObject({
			clock: 'content', phase_offset_ms: 3000, disable_after_ms: 3001,
		});
		expect(() => graphicsTiming({ mode: 'periodic', clock: 'wall', phase: 0, fade: 1, hold: 98, frequency: 100 }, 100_000)).toThrow(/appearances/);
	});

	it('keeps the main source playable and restores an overlay on a later preparation', async () => {
		const state = await fixture();
		try {
			const { repository, root } = state;
			const assetId = randomUUID();
			repository.graphics.addAsset({ id: assetId, name: 'missing.png', kind: 'image', format: 'png', protected: false });
			const [layer] = parseGraphics(graphicsExamples[0]!.yaml).layers;
			const preset = repository.graphics.save({ name: 'Missing asset', yaml: `version: 1\nlayers: ${JSON.stringify([{ ...layer, assetId }])}` });
			const channel = await repository.createChannel(channelCreateSchema.parse({ number: '7', name: 'Test TV', graphicsPresetId: preset.id }));
			const start = Date.now() + 60_000;
			const span = segment(start, start + 5000);
			const source = { source_type: 'local', path: span.playbackPath };
			const files = new Map([['day.json', JSON.stringify({ version: ETV_PLAYOUT_VERSION, items: [{ id: `${span.id}:2026-10-02`, start: span.start, finish: span.finish, source }] })]]);
			const result = await decorateGraphics(root, repository.graphics.preparePresets(graphicsPresetIds(channel, [span])), channel, [span], files, () => false, await GraphicsSnapshots.open(path.join(root, 'snapshots')));
			expect(result.issue).toBeTruthy();
			expect(JSON.parse(result.files.get('day.json')!).items[0]).toMatchObject({ source });
			expect(JSON.parse(result.files.get('day.json')!).items[0].graphics).toBeUndefined();

			const bundled = await graphicsAssetPath(root, exampleGraphicsAssets[0]!);
			await publishGraphicsFile(path.join(root, 'assets', `${assetId}.png`), await readFile(bundled));
			const retried = await decorateGraphics(root, repository.graphics.preparePresets(graphicsPresetIds(channel, [span])), channel, [span], files, () => false, await GraphicsSnapshots.open(path.join(root, 'snapshots')));
			expect(retried.issue).toBeUndefined();
			expect(JSON.parse(retried.files.get('day.json')!).items[0].graphics).toHaveLength(1);
		}
		finally {
			await state.close();
		}
	});

	it('rasterizes a rounded rectangle with transparent corners and an opaque fill', async () => {
		const state = await fixture();
		try {
			const document = shapedFixture;
			const snapshots = await GraphicsSnapshots.open(path.join(state.root, 'snapshots'));
			const layer = await prepareGraphicsLayer(
				state.root, document.layers[0]!, state.repository.graphics.validateAssets(document),
				sampleGraphicsContext, 5000, snapshots, { width: 1920, height: 1080 },
			);
			expect(layer).toMatchObject({ kind: 'media', location: 'bottom_left', width_percent: 34 });
			const { data, info } = await sharp(layer!.source.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			expect(data[3]).toBe(0);
			const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
			expect([...data.subarray(center, center + 4)]).toEqual([16, 60, 54, 255]);
		}
		finally {
			await state.close();
		}
	});

	it.each([0, 90])('rasterizes both gradient colors and alpha with shape rotation %i', async rotation => {
		const state = await fixture();
		try {
			const [example] = shapedFixture.layers;
			if (example?.kind !== 'shape') {
				throw new Error('Expected a shape example');
			}
			const document = parseGraphics(JSON.stringify({ version: 1, layers: [{
				...example, anchor: 'center', horizontalMargin: 0, verticalMargin: 0, withinSource: false, width: undefined, rotation,
				shape: { ...example.shape, width: 100, height: 100, strokeWidth: 0, gradient: {
					angle: 90, start: { color: '#FF0000', opacity: 100 }, end: { color: '#0000FF', opacity: 20 },
				} },
			}] }));
			const [layer] = document.layers;
			const snapshots = await GraphicsSnapshots.open(path.join(state.root, 'snapshots'));
			const video = channelCreateSchema.parse({ number: '1', name: 'Gradient' }).video;
			const assets = state.repository.graphics.validateAssets(document);
			const rendered = rotation
				? await transformedGraphics(state.root, document.layers, assets, sampleGraphicsContext, snapshots, video, undefined, null, 'ffprobe')(layer!, 5000)
				: await prepareGraphicsLayer(state.root, layer!, assets, sampleGraphicsContext, 5000, snapshots, video);
			const { data, info } = await sharp(rendered!.source.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
			const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
			const [startR, , startB, startAlpha] = rotation ? pixel(50, 5) : pixel(5, 50);
			const [endR, , endB, endAlpha] = rotation ? pixel(50, 94) : pixel(94, 50);
			expect(startR!).toBeGreaterThan(startB!);
			expect(endB!).toBeGreaterThan(endR!);
			expect(startAlpha!).toBeGreaterThan(230);
			expect(endAlpha!).toBeLessThan(80);
		}
		finally {
			await state.close();
		}
	});

	it('materializes the animated example with multiple GIF frames', async () => {
		const state = await fixture();
		try {
			const document = parseGraphics(graphicsExamples[3]!.yaml);
			const layer = await prepareGraphicsLayer(state.root, document.layers[0]!, state.repository.graphics.validateAssets(document), sampleGraphicsContext, 5000, await GraphicsSnapshots.open(path.join(state.root, 'snapshots')), { width: 1920, height: 1080 });
			expect((await sharp(layer!.source.path, { animated: true }).metadata()).pages).toBeGreaterThan(1);
		}
		finally {
			await state.close();
		}
	});
});

const engine = process.env.MOIRAI_TEST_GRAPHICS_ENGINE;
it('uses a fixed upcoming strip with two, one, or zero scheduled entries', async () => {
	const ticker = parseGraphics(graphicsExamples[5]!.yaml).layers.find(layer => layer.kind === 'text' && layer.text.includes('upcoming'));
	if (ticker?.kind !== 'text') {
		throw new Error('Expected an upcoming title layer');
	}
	const liquid = createBoundedLiquid({ parseLimit: 4096, renderLimit: 100 });
	const first = { ...sampleGraphicsContext.upcoming[0]!, title: 'A very long programme title for the strip' };
	const second = sampleGraphicsContext.upcoming[1]!;
	const two = await liquid.parseAndRender(ticker.text, { upcoming: [first, second] });
	expect(two).toContain('14:30');
	expect(two).toContain('...');
	expect(two).toContain('│');
	expect(two).toContain('15:30');
	expect(await liquid.parseAndRender(ticker.text, { upcoming: [first] })).not.toContain('│');
	expect(await liquid.parseAndRender(ticker.text, { upcoming: [] })).toBe('Schedule to be announced');
});

it('resolves attachments to transformed bounds in either draw order and rejects cycles', () => {
	const [shape, text] = shapedFixture.layers;
	const target = { ...shape!, rotation: 90 };
	const child = { ...text!, anchor: 'center_left' as const, attachment: { layerId: target.id, anchor: 'center_left' as const, offsetX: 4, offsetY: 0 } };
	const geometry = resolveGraphicsGeometry([child, target], new Map([[target.id, { width: 720, height: 140 }], [child.id, { width: 190, height: 42 }]]), { width: 1920, height: 1080 });
	const parent = geometry.get(target.id)!.bounds;
	const attached = geometry.get(child.id)!.bounds;
	expect(attached.x).toBeCloseTo(parent.x + parent.width * 0.04);
	expect(attached.y + attached.height / 2).toBeCloseTo(parent.y + parent.height / 2);
	expect(() => parseGraphics(JSON.stringify({ version: 1, layers: [child, {
		...target, attachment: { layerId: child.id, anchor: 'center', offsetX: 0, offsetY: 0 },
	}] }))).toThrow(/cycle/);
});

it('keeps a corner-anchored shape and an edge-attached text layer centered as each rotates', () => {
	const [shape, text] = shapedFixture.layers;
	const target = { ...shape!, anchor: 'bottom_right' as const };
	const child = { ...text!, anchor: 'center_left' as const, attachment: { layerId: target.id, anchor: 'center_left' as const, offsetX: 4, offsetY: 0 } };
	const sizes = new Map([[target.id, { width: 720, height: 140 }], [child.id, { width: 190, height: 42 }]]);
	const frame = { width: 1920, height: 1080 };
	const baseline = resolveGraphicsGeometry([target, child], sizes, frame);
	const turnedTarget = resolveGraphicsGeometry([{ ...target, rotation: 90 }, child], sizes, frame);
	const turnedChild = resolveGraphicsGeometry([target, { ...child, rotation: 90 }], sizes, frame);
	for (const [id, after] of [[target.id, turnedTarget], [child.id, turnedChild]] as const) {
		const before = baseline.get(id)!.bounds;
		const rotated = after.get(id)!.bounds;
		expect(rotated.width).toBeCloseTo(before.height);
		expect(rotated.x + rotated.width / 2).toBeCloseTo(before.x + before.width / 2);
		expect(rotated.y + rotated.height / 2).toBeCloseTo(before.y + before.height / 2);
	}
});

it.skipIf(!engine || !existsSync(engine))('renders a rotated animated overlay and attached text through Next', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const [media] = parseGraphics(graphicsExamples[3]!.yaml).layers;
		const [, text] = shapedFixture.layers;
		const rotated = { ...media!, rotation: 25 };
		const attached = { ...text!, rotation: -10, attachment: { layerId: rotated.id, anchor: 'top_left' as const, offsetX: -100, offsetY: -20 } };
		const rendered = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [rotated, attached] }, null, 5000);
		const blank = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [] }, null, 5000);
		expect(rendered.equals(blank)).toBe(false);

		const emptyTarget = { ...text!, text: '{{ now.missing }}' };
		const warnings: string[] = [];
		const withMissingTarget = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [emptyTarget, {
			...rotated, attachment: { layerId: emptyTarget.id, anchor: 'center', offsetX: 0, offsetY: 0 },
		}] }, null, 5000, false, warning => warnings.push(warning));
		expect(withMissingTarget.equals(blank)).toBe(true);
		expect(warnings).toEqual([expect.stringContaining('no measurable bounds')]);
	}
	finally {
		await state.close();
	}
}, 30_000);

it.skipIf(!engine || !existsSync(engine))('admits an explicit preview behind an active gallery sample', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const document = parseGraphics(graphicsExamples[0]!.yaml);
		const sample = renderGraphicsSampleClip(config, state.repository, document);
		const preview = renderGraphicsPreview(config, state.repository, document, null, 0);
		const results = await Promise.allSettled([sample, preview]);
		expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
	}
	finally {
		await state.close();
	}
}, 35_000);

it.skipIf(!engine || !existsSync(engine))('saves looping gallery clips with native animation and fades', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		for (const index of [1, 3, 4]) {
			const preset = graphicsExamples[index]!;
			const clip = await getGraphicsSampleClip(config, state.repository, preset);
			const file = path.join(state.root, `sample-${index}.mp4`);
			await writeFile(file, clip);
			const { stdout } = await runGraphicsProcess('ffprobe', [
				'-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
			]);
			expect(Number(stdout)).toBeCloseTo(6, 0);
			const { stdout: frames } = await runGraphicsProcess('ffmpeg', [
				'-v', 'error', '-i', file, '-vf', 'fps=4', '-f', 'framemd5', '-',
			]);
			const hashes = frames.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1));
			expect(new Set(hashes).size).toBeGreaterThan(1);
			const offline = { ...config, playbackEnginePath: path.join(state.root, 'missing-engine') };
			expect(await getGraphicsSampleClip(offline, state.repository, preset)).toEqual(clip);
		}
	}
	finally {
		await state.close();
	}
}, 90_000);
it('validates APNG uploads under both PNG extensions and rejects a false frame count', async () => {
	const state = await fixture();
	try {
		const file = path.join(state.root, 'overlay.apng');
		await runGraphicsProcess('ffmpeg', [
			'-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=32x32:r=4',
			'-frames:v', '4', '-plays', '0', '-f', 'apng', file,
		], { timeout: 5000 });
		const bytes = await readFile(file);
		for (const filename of ['overlay.apng', 'overlay.png']) {
			const asset = await storeGraphicsAsset(state.root, filename, bytes, 'ffprobe');
			expect(asset).toMatchObject({ name: filename, kind: 'image', format: 'apng' });
			expect(await readFile(await graphicsAssetPath(state.root, asset))).toEqual(bytes);
		}
		const still = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'black' } }).png().toBuffer();
		await expect(storeGraphicsAsset(state.root, 'still.apng', still, 'ffprobe')).rejects.toThrow(/APNG/);
		const control = bytes.indexOf('acTL');
		bytes.writeUInt32BE(241, control + 4);
		await expect(storeGraphicsAsset(state.root, 'oversized.png', bytes, 'ffprobe')).rejects.toThrow(/frame count/);
	}
	finally {
		await state.close();
	}
});

it.skipIf(!engine || !existsSync(engine))('renders an uploaded APNG over the sample channel through Next', async () => {
	const state = await fixture();
	try {
		const file = path.join(state.root, 'overlay.apng');
		await runGraphicsProcess('ffmpeg', [
			'-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=64x64:r=1',
			'-frames:v', '4', '-plays', '0', '-f', 'apng', file,
		], { timeout: 5000 });
		const asset = await storeGraphicsAsset(graphicsFolder(state.root), 'overlay.apng', await readFile(file), 'ffprobe');
		state.repository.graphics.addAsset(asset);
		const [layer] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const document = parseGraphics(`version: 1\nlayers: ${JSON.stringify([{ ...layer, assetId: asset.id, width: 30 }])}`);
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const first = await renderGraphicsPreview(config, state.repository, document, null, 250);
		const blank = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [] }, null, 250);
		expect(blank.equals(first)).toBe(false);
	}
	finally {
		await state.close();
	}
}, 30_000);

it.skipIf(!engine || !existsSync(engine))('renders the protected examples through Next and applies the sampled content fade', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const documents = graphicsExamples.map(preset => parseGraphics(preset.yaml));
		const blank = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [] }, null, 5000);
		for (const document of documents) {
			const visible = await renderGraphicsPreview(config, state.repository, document!, null, 5000);
			expect(visible.equals(blank)).toBe(false);
		}
		const lowerThird = documents[1]!;
		const hidden = await renderGraphicsPreview(config, state.repository, lowerThird, null, 0);
		expect(hidden.equals(blank)).toBe(true);
		const background = await sharp(blank).raw().toBuffer();
		const difference = async (elapsed: number): Promise<number> => {
			const frame = await renderGraphicsPreview(config, state.repository, lowerThird!, null, elapsed);
			const pixels = await sharp(frame).raw().toBuffer();
			return pixels.reduce((sum, value, index) => sum + Math.abs(value - background[index]!), 0);
		};
		const full = await difference(5000);
		for (const elapsed of [3750, 13_750]) {
			const ratio = await difference(elapsed) / full;
			expect(ratio).toBeGreaterThan(0.3);
			expect(ratio).toBeLessThan(0.7);
		}
	}
	finally {
		await state.close();
	}
}, 90_000);

it('passes the selected track and guide labels to the channel preview worker', async () => {
	const state = await fixture();
	try {
		const template = await state.repository.guideTemplates.save({ name: 'Selected channel labels', description: '', sources: {
			...BUILTIN_GUIDE_TEMPLATE.sources,
			other: '<programme start="{{ start }}" stop="{{ stop }}" channel="{{ channel.id }}"><title>Guide: {{ slot.title }}</title><sub-title>Tonight</sub-title></programme>',
		} });
		const channel = await state.repository.createChannel(channelCreateSchema.parse({
			number: '26.2', name: 'Preview station', guideTemplateId: template.id,
		}));
		const now = Date.now() + 5000;
		const mediaItemId = randomUUID();
		const source = path.join(state.root, 'source.mp4');
		await writeFile(source, '');
		vi.spyOn(state.repository, 'listMaterializedTimelineSegments').mockResolvedValue([{
			segment: segment(now, now + 8000, { channelId: channel.id, playbackPath: source, mediaItemId }),
			mediaSnapshot: null, stateDelta: [],
		}]);
		vi.spyOn(state.repository, 'audioMetadata').mockResolvedValue(new Map([[source, { streams: [
			{ type: 'video', index: 0, isAttachedPicture: true },
			{ type: 'video', index: 2 },
		] }]]));
		const captured = path.join(state.root, 'captured.json');
		const executable = path.join(state.root, 'preview-worker');
		await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(path.dirname(process.argv[3]), 'playout');
fs.copyFileSync(path.join(dir, fs.readdirSync(dir)[0]), ${JSON.stringify(captured)});
`, { mode: 0o755 });
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: executable });
		const position = await resolveGraphicsPreviewPosition(state.repository, channel, 0, config.timeZone, config.publicUrl);
		expect(position.preview.context.now).toMatchObject({ title: 'Guide: Main Feature', subtitle: 'Tonight' });
		const layer = { ...shapedFixture.layers[1]!, text: '{{ channel.number }} {{ now.title }} · {{ now.subtitle }}' };
		await expect(renderGraphicsPreview(config, state.repository, { version: 1, layers: [layer] }, channel, 0)).rejects.toMatchObject({ reason: 'no_frame' });
		const [item] = JSON.parse(await readFile(captured, 'utf8')).items;
		expect(item.tracks.video.stream_index).toBe(2);

		const literal = { ...layer, text: '26.2 Guide: Main Feature · Tonight' };
		await expect(renderGraphicsPreview(config, state.repository, { version: 1, layers: [literal] }, channel, 0)).rejects.toMatchObject({ reason: 'no_frame' });
		const [expected] = JSON.parse(await readFile(captured, 'utf8')).items;
		expect(path.basename(item.graphics[0].source.path)).toBe(path.basename(expected.graphics[0].source.path));
	}
	finally {
		await state.close();
	}
});

it.skipIf(!engine || !existsSync(engine))('renders selected channel video and restarts overlay timing at a physical split', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const channel = await state.repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Preview station' }));
		const video = path.join(state.root, 'red.mp4');
		await runGraphicsProcess('ffmpeg', [
			'-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=30',
			'-t', '10', '-c:v', 'libx264', video,
		], { timeout: 10_000 });
		const start = Math.ceil(Date.now() / 60_000) * 60_000 + 20_000;
		vi.spyOn(state.repository, 'listMaterializedTimelineSegments').mockResolvedValue([{
			segment: segment(start, start + 8000, { channelId: channel.id, playbackPath: video, sourceStartSeconds: 2,
				playbackParts: [{ playbackPath: video, durationSeconds: 6 }, { playbackPath: video, durationSeconds: 4 }] }),
			mediaSnapshot: null,
			stateDelta: [],
		}]);

		const draft = parseGraphics(graphicsExamples[2]!.yaml);
		const png = await renderGraphicsPreview(config, state.repository, draft, channel, 1000);
		const visible = await renderGraphicsPreview(config, state.repository, draft, channel, 1000, true);
		expect(visible.equals(png)).toBe(false);
		const { data } = await sharp(png).extract({ left: 50, top: 50, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
		expect(data[0]).toBeGreaterThan(200);
		expect(data[2]).toBeLessThan(30);
		const [watermark] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const afterSplit = await renderGraphicsPreview(config, state.repository, {
			version: 1, layers: [{ ...watermark!, timing: { mode: 'once', phase: 0, fade: 100, hold: 1200 } }],
		}, channel, 4500);
		const blank = await renderGraphicsPreview(config, state.repository, { version: 1, layers: [] }, channel, 4500);
		expect(afterSplit.equals(blank)).toBe(false);
		await expect(renderGraphicsPreview(config, state.repository, draft, channel, 8000)).rejects.toThrow(/No committed programme video/);
	}
	finally {
		await state.close();
	}
}, 25_000);

it('samples the authored opacity halfway through both ramps and on the wall clock', () => {
	const [layer] = parseGraphics(graphicsExamples[1]!.yaml).layers;
	expect(graphicsPreviewOpacity(layer!, 0, 3750)).toBeCloseTo(layer!.opacity / 2);
	expect(graphicsPreviewOpacity(layer!, 0, 13_750)).toBeCloseTo(layer!.opacity / 2);
	const wall = { ...layer!, timing: { mode: 'periodic', clock: 'wall', phase: 0, fade: 1000, hold: 6000, frequency: 60_000 } as const };
	expect(graphicsPreviewOpacity(wall, 30_000, 0)).toBe(0);
	expect(graphicsPreviewOpacity(wall, 30_000, 30_500)).toBeCloseTo(layer!.opacity / 2);
});

it.skipIf(!engine || !existsSync(engine))('previews rapid cycles without counting elapsed time as render work', async () => {
	const state = await fixture();
	try {
		const config = loadConfig({ dataDir: state.root, playbackEnginePath: engine! });
		const [layer] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const draft = {
			version: 1 as const,
			layers: [{ ...layer!, timing: { mode: 'periodic', clock: 'content', phase: 0, fade: 1, hold: 8, frequency: 10 } as const }],
		};
		const png = await renderGraphicsPreview(config, state.repository, draft, null, 2000);
		expect((await sharp(png).metadata()).format).toBe('png');
	}
	finally {
		await state.close();
	}
}, 25_000);

it('rejects a zero-duration timed fade at the authoring boundary', () => {
	const example = parseGraphics(graphicsExamples[1]!.yaml);
	const [layer] = example.layers;
	const yaml = `version: 1\nlayers: ${JSON.stringify([{ ...layer, timing: { mode: 'once', phase: 0, fade: 0, hold: 500 } }])}`;
	expect(() => parseGraphics(yaml)).toThrow(/fade/);
});

it('rejects a name-table-only font before publishing the upload', async () => {
	const state = await fixture();
	try {
		const font = Buffer.alloc(54);
		font.writeUInt32BE(0x00010000, 0);
		font.writeUInt16BE(1, 4);
		font.write('name', 12, 'ascii');
		font.writeUInt32BE(28, 20);
		font.writeUInt32BE(26, 24);
		font.writeUInt16BE(1, 30);
		font.writeUInt16BE(18, 32);
		font.writeUInt16BE(3, 34);
		font.writeUInt16BE(1, 40);
		font.writeUInt16BE(8, 42);
		Buffer.from('Test', 'utf16le').swap16().copy(font, 46);
		expect(graphicsFontFamily(font)).toBe('Test');
		await expect(storeGraphicsAsset(state.root, 'names-only.ttf', font, 'ffprobe')).rejects.toThrow();
	}
	finally {
		await state.close();
	}
});

it('keeps a published snapshot after retiring its original and reclaims it when unreferenced', async () => {
	const state = await fixture();
	try {
		const bytes = await readFile(await graphicsAssetPath(state.root, exampleGraphicsAssets[0]!));
		const asset = await storeGraphicsAsset(state.root, 'watermark.png', bytes, 'ffprobe');
		state.repository.graphics.addAsset(asset);
		const original = await graphicsAssetPath(state.root, asset);
		const snapshots = await GraphicsSnapshots.open(path.join(state.root, 'snapshots'));
		const snapshot = await snapshots.media(original);
		await removeGraphicsOriginal(state.root, state.repository.graphics.deleteAsset(asset.id));
		await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' });
		await snapshots.prune(new Set([snapshot]));
		expect(await readFile(snapshot)).toEqual(bytes);
		await snapshots.prune(new Set());
		await expect(readFile(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
	}
	finally {
		await state.close();
	}
});

it('rejects new snapshots at capacity and reuses a published one', async () => {
	const state = await fixture();
	try {
		const folder = path.join(state.root, 'snapshots');
		await mkdir(folder);
		const names = Array.from({ length: GRAPHICS_SNAPSHOT_LIMIT }, (_, index) => index.toString(16).padStart(64, '0') + '.png');
		await Promise.all(names.map(name => writeFile(path.join(folder, name), 'cached')));
		const snapshots = await GraphicsSnapshots.open(folder);
		await expect(snapshots.use('f'.repeat(64) + '.png', async () => {})).rejects.toThrow(/capacity/);
		expect(await snapshots.use(names[0]!, async () => { throw new Error('already cached'); })).toBe(path.join(folder, names[0]!));
	}
	finally {
		await state.close();
	}
});

it('pre-scales percentage graphics for source-sized playout', async () => {
	const state = await fixture();
	try {
		const { root, repository } = state;
		const video = path.join(root, 'source.mp4');
		await runGraphicsProcess('ffmpeg', [
			'-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x180', '-frames:v', '1', '-c:v', 'libx264', video,
		], { timeout: 5000 });
		const draft = channelCreateSchema.parse({ number: '1', name: 'Source-sized', graphicsPresetId: graphicsExamples[0]!.id });
		const channel = await repository.createChannel({ ...draft, video: { ...draft.video, width: null, height: null } });
		const start = Date.now() + 10_000;
		const span = segment(start, start + 5000);
		const files = new Map([['day.json', JSON.stringify({ version: ETV_PLAYOUT_VERSION, items: [{
			id: `${span.id}:2026-10-02`, start: span.start, finish: span.finish,
			source: { source_type: 'local', path: video },
		}] })]]);
		const presets = repository.graphics.preparePresets(graphicsPresetIds(channel, [span]));
		const snapshots = await GraphicsSnapshots.open(path.join(root, 'snapshots'));
		const result = await decorateGraphics(root, presets, channel, [span], files, () => false, snapshots);
		expect(result.issue).toBeUndefined();
		const [graphic] = JSON.parse(result.files.get('day.json')!).items[0].graphics;
		expect(graphic.width_percent).toBeUndefined();
		expect((await sharp(graphic.source.path).metadata()).width).toBeCloseTo(320 * 0.12, 0);
	}
	finally {
		await state.close();
	}
});

it.each([0, 45])('keeps the primary source when an oversized image rotated %i degrees is omitted', async rotation => {
	const state = await fixture();
	try {
		const { root, repository } = state;
		const bytes = await sharp({ create: { width: 1, height: 2160, channels: 3, background: 'white' } }).png().toBuffer();
		const asset = await storeGraphicsAsset(root, 'tall.png', bytes, 'ffprobe');
		repository.graphics.addAsset(asset);
		const [layer] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const preset = repository.graphics.save({ name: 'Tall graphic', yaml: `version: 1\nlayers: ${JSON.stringify([{ ...layer, assetId: asset.id, width: 100, rotation }])}` });
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '7', name: 'Test TV', graphicsPresetId: preset.id }));
		const start = Date.now() + 60_000;
		const span = segment(start, start + 5000);
		const source = { source_type: 'local', path: span.playbackPath };
		const files = new Map([['day.json', JSON.stringify({ version: ETV_PLAYOUT_VERSION, items: [{ id: `${span.id}:2026-10-02`, start: span.start, finish: span.finish, source }] })]]);
		const result = await decorateGraphics(root, repository.graphics.preparePresets(graphicsPresetIds(channel, [span])), channel, [span], files, () => false, await GraphicsSnapshots.open(path.join(root, 'snapshots')));
		expect(result.issue).toBeTruthy();
		const [item] = JSON.parse(result.files.get('day.json')!).items;
		expect(item.source).toEqual(source);
		expect(item.graphics).toBeUndefined();
	}
	finally {
		await state.close();
	}
});

it('rejects corrupt graphics video even when its container metadata passes', async () => {
	const state = await fixture();
	try {
		const file = path.join(state.root, 'overlay.mp4');
		await runGraphicsProcess(process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg', [
			'-v', 'error', '-f', 'lavfi', '-i', 'color=s=64x64:d=1', '-c:v', 'libx264', file,
		], { timeout: 5000 });
		const video = await readFile(file);
		const ffprobe = process.env.MOIRAI_TEST_FFMPEG
			? path.join(path.dirname(process.env.MOIRAI_TEST_FFMPEG), 'ffprobe') : 'ffprobe';
		expect((await storeGraphicsAsset(state.root, 'valid.mp4', video, ffprobe)).kind).toBe('video');
		if (process.platform !== 'win32') {
			const probeOnly = path.join(state.root, 'ffprobe');
			await symlink((await graphicsPreviewExecutable(ffprobe, ''))!, probeOnly);
			expect((await storeGraphicsAsset(state.root, 'separate-probe.mp4', video, probeOnly)).kind).toBe('video');
		}
		for (let offset = 0; offset + 8 <= video.length;) {
			const size = video.readUInt32BE(offset);
			if (video.toString('ascii', offset + 4, offset + 8) === 'mdat') {
				video.fill(0, offset + 8, offset + size);
				break;
			}
			offset += size;
		}
		await expect(storeGraphicsAsset(state.root, 'damaged.mp4', video, ffprobe)).rejects.toThrow();
	}
	finally {
		await state.close();
	}
});

it('rejects oversized generated text before it occupies a snapshot slot', async () => {
	const state = await fixture();
	try {
		const layer = shapedFixture.layers[1]!;
		if (layer.kind !== 'text') {
			throw new Error('Expected a text fixture');
		}
		const directory = path.join(state.root, 'snapshots');
		const snapshots = await GraphicsSnapshots.open(directory);
		await expect(prepareGraphicsLayer(state.root, { ...layer, text: 'I', width: 100 },
			new Map(), sampleGraphicsContext, 5000, snapshots, { width: 1920, height: 1080 })).rejects.toThrow(/dimensions/);
		expect(existsSync(directory)).toBe(false);
	}
	finally {
		await state.close();
	}
});

it('resolves a configured preview probe wrapper through PATH', async () => {
	const state = await fixture();
	try {
		const name = process.platform === 'win32' ? 'probe-wrapper.exe' : 'probe-wrapper';
		const executable = path.join(state.root, name);
		await writeFile(executable, '', { mode: 0o700 });
		vi.stubEnv('PATH', state.root);
		await expect(graphicsPreviewExecutable(name, 'ffprobe')).resolves.toBe(executable);
		await expect(graphicsPreviewExecutable('ffprobe', 'ffprobe')).resolves.toBeNull();
	}
	finally {
		vi.unstubAllEnvs();
		await state.close();
	}
});

it('reuses a prepared watermark on later items after the live preparation budget expires', async () => {
	const state = await fixture();
	let elapsed = 0;
	const timer = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
	const original = graphicsRendering.prepareGraphicsLayer;
	const prepare = vi.spyOn(graphicsRendering, 'prepareGraphicsLayer').mockImplementation(async (...args) => {
		const layer = await original(...args);
		elapsed = 60_000;
		return layer;
	});
	try {
		const { root, repository } = state;
		const [image] = parseGraphics(graphicsExamples[0]!.yaml).layers;
		const [, text] = shapedFixture.layers;
		const preset = repository.graphics.save({
			name: 'Budget test', yaml: `version: 1\nlayers: ${JSON.stringify([image, { ...text, id: randomUUID() }])}`,
		});
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '7', name: 'Test TV', graphicsPresetId: preset.id }));
		const start = Date.now() + 60_000;
		const spans = [segment(start, start + 5000), segment(start + 5000, start + 17_000)];
		const items = spans.map(span => ({
			id: `${span.id}:2026-10-02`, start: span.start, finish: span.finish,
			source: { source_type: 'local', path: span.playbackPath },
		}));
		const files = new Map([['day.json', JSON.stringify({ version: ETV_PLAYOUT_VERSION, items })]]);
		const result = await decorateGraphics(root, repository.graphics.preparePresets(graphicsPresetIds(channel, spans)), channel, spans, files, () => true, await GraphicsSnapshots.open(path.join(root, 'snapshots')));
		const [first, second] = JSON.parse(result.files.get('day.json')!).items;
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(first.graphics).toHaveLength(1);
		expect(second.graphics).toEqual(first.graphics);
		expect(result.issue).toBeTruthy();
	}
	finally {
		prepare.mockRestore();
		timer.mockRestore();
		await state.close();
	}
});

it('keeps the prepared clock and defers later clocks once the live budget expires', async () => {
	const state = await fixture();
	let elapsed = 0;
	const timer = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
	try {
		const { root, repository } = state;
		const preset = graphicsExamples[4]!;
		const channel = await repository.createChannel(channelCreateSchema.parse({
			number: '7', name: 'Test TV', graphicsPresetId: preset.id,
			video: { width: 1920, height: 1080, scalingMode: 'stretch' },
		}));
		const clock = {
			layer: vi.fn<GraphicsClock['layer']>(async () => {
				elapsed = graphicsPreparationBudget.live;
				return {
					kind: 'canvas', location: 'top_left', layout: { mode: 'region', origin: { x: 0, y: 0 } },
					source: {
						source_type: 'http', uri: 'http://127.0.0.1/clock', reconnect: false, timeout_us: 5_000_000,
						probe_hint: { format_name: 'apng', video: [{
							codec: 'apng', width: 384, height: 108, pix_fmt: 'rgba', stream_index: 0, frame_rate: '1/1',
						}] },
					},
				};
			}),
			close: vi.fn<GraphicsClock['close']>(),
		};
		const start = Date.now() + 60_000;
		const spans = [segment(start, start + 5000), segment(start + 5000, start + 10_000)];
		const items = spans.map(span => ({
			id: span.id, start: span.start, finish: span.finish,
			source: { source_type: 'local', path: span.playbackPath },
		}));
		const files = new Map([['day.json', JSON.stringify({ version: ETV_PLAYOUT_VERSION, items })]]);
		const snapshots = await GraphicsSnapshots.open(path.join(root, 'snapshots'));
		const presets = repository.graphics.preparePresets(new Set([preset.id]));
		const result = await decorateGraphics(root, presets, channel, spans, files, () => true, snapshots, undefined, 'UTC', clock);
		const [first, second] = JSON.parse(result.files.get('day.json')!).items;
		expect(clock.layer).toHaveBeenCalledTimes(1);
		expect(first.graphics).toMatchObject([{ kind: 'canvas' }]);
		expect(second.graphics).toBeUndefined();
		expect(second.source).toEqual(items[1]!.source);
		expect(result.issue).toMatch(/still being prepared/);
	}
	finally {
		timer.mockRestore();
		await state.close();
	}
});

it('shares an in-progress snapshot between preparation passes and exposes its completed file for retry', async () => {
	const state = await fixture();
	try {
		const directory = path.join(state.root, 'snapshots');
		const retries = { pending: new Map<string, Promise<void>>(), warmed: new Set<string>() };
		const first = await GraphicsSnapshots.open(directory, retries);
		const name = 'a'.repeat(64) + '.png';
		let finish!: () => void;
		const gate = new Promise<void>(resolve => { finish = resolve; });
		const render = first.use(name, async destination => {
			await gate;
			await publishGraphicsFile(destination, Buffer.from('completed'));
		});
		try {
			const next = await GraphicsSnapshots.open(directory, retries);
			const duplicate = vi.fn(async () => {});
			const reuse = next.use(name, duplicate);
			const independent = await GraphicsSnapshots.open(path.join(state.root, 'independent'));
			const second = independent.use('b'.repeat(64) + '.png', async () => { await gate; });
			try {
				const cachedDir = path.join(state.root, 'cached');
				const cachedName = 'c'.repeat(64) + '.png';
				await publishGraphicsFile(path.join(cachedDir, cachedName), Buffer.from('cached'));
				const cached = await GraphicsSnapshots.open(cachedDir);
				await expect(cached.use(cachedName, duplicate)).resolves.toBe(path.join(cachedDir, cachedName));
				await expect(independent.use('d'.repeat(64) + '.png', duplicate)).rejects.toBeInstanceOf(GraphicsSnapshotBusyError);
			}
			finally {
				finish();
				await second;
			}
			const [published, reused] = await Promise.all([render, reuse]);
			expect(reused).toBe(published);
			expect(await readFile(reused, 'utf8')).toBe('completed');
			expect(duplicate).not.toHaveBeenCalled();
			expect(retries.warmed.has(name)).toBe(true);
			expect(retries.pending.size).toBe(0);
		}
		finally {
			finish();
			await render;
		}
	}
	finally {
		await state.close();
	}
});
