import { Temporal } from '@js-temporal/polyfill';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
	channelCreateSchema, channelScheduleConfigSchema, graphicsPreviewContextSchema, libraryCreateSchema, programCreateSchema,
	scheduleTemplateCreateSchema, SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { materializedTimelineSegments } from '@server/db/schema.js';
import { parseGraphics } from '@server/graphics/document.js';
import { prepareGraphicsLayer } from '@server/graphics/render.js';
import { preparePlayoutGraphicsLabels } from '@server/graphics/segments.js';
import { GraphicsSnapshots } from '@server/graphics/snapshots.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';

it('renders committed movie, episode, and music video metadata and enriches legacy graphics snapshots', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-graphics-metadata-'));
	const database = createDatabase(':memory:', 'drizzle');
	const repository = new Repository(database.db);
	const timeline = new TimelineMaterializer(repository, { publish: vi.fn() }, 'UTC', undefined, undefined, 1);
	try {
		async function indexItem(kind: string, stem: string, nfo: string, durationSeconds: number) {
			const folder = path.join(root, kind);
			const filename = path.join(folder, stem);
			await mkdir(path.dirname(filename), { recursive: true });
			await writeFile(`${filename}.mp4`, 'video');
			const library = await repository.createLibrary(libraryCreateSchema.parse({
				name: kind, typeKey: kind, sourceType: 'on-disk', sourceConfig: { scanRoot: folder },
			}));
			async function scan(source: string) {
				await writeFile(`${filename}.nfo`, source);
				const result = await discoverOnDisk(library, { probeMedia: async () => ({
					durationMilliseconds: durationSeconds * 1_000, fileSizeBytes: 5, container: 'mp4', streams: [], resolution: null, tags: {},
				}) });
				const run = await repository.beginScan(library.id, 'manual');
				await repository.reconcileScan(run, result.groups, result.items, result.issues, true);
				return result.items[0]!.id;
			}
			return { id: await scan(nfo), scan };
		}

		const songDuration = 120;
		const episodeDuration = 1_800;
		const song = await indexItem('music-videos', 'Song', '<musicvideo><title>Song</title><artist>A &amp; [credit]B[/credit]</artist>'
			+ '<artist>Guest</artist><album>Night Signals</album><track>4</track><disc>2</disc></musicvideo>', songDuration);
		const episode = await indexItem('shows', 'Alpine Series/Season 1/S01E03', '<episodedetails><title>Rescue</title>'
			+ '<season>1</season><episode>3</episode></episodedetails>', episodeDuration);
		const movie = await indexItem('movies', 'Summit {edition-Extended Cut}', '<movie><title>Summit</title><originaltitle>Gipfel</originaltitle>'
			+ '<genre>Drama</genre><genre primary="true">Adventure</genre><tag>Mountain</tag><rating>7.5</rating><userrating>0</userrating><mpaa>PG</mpaa>'
			+ '<actor><name>Pat Reed</name><role>Guide</role><order>2</order></actor>'
			+ '<actor><name>Ana Rivera</name><role>Climber</role><order>1</order></actor>'
			+ '<director>Alex Chen</director><writer>Jess King</writer><studio>Alpine Pictures</studio><country>Canada</country></movie>', 3_600);

		const text = '{{ media.artists | join: ", " }} · {{ media.album }}';
		const overlay = repository.graphics.save({ name: 'Music credits', yaml: JSON.stringify({ version: 1, layers: [{
			id: randomUUID(), kind: 'text', anchor: 'bottom_left', horizontalMargin: 4, verticalMargin: 4, opacity: 100,
			withinSource: true, timing: { mode: 'always' }, text, style: { size: 32, color: '#FFFFFF' },
			styles: { credit: { size: 32, color: '#FFFF00' } },
		}] }) });
		const [musicProgram, episodeProgram, movieProgram] = await Promise.all([song, episode, movie].map((item, index) =>
			repository.createProgram(programCreateSchema.parse({ name: `Metadata program ${index + 1}`, config: {
				type: 'content', source: { type: 'item', itemId: item.id }, strategy: { type: 'sequential' },
			} }))));
		const { preset } = await repository.fillerPresets.save({ kind: 'pre-roll', name: 'One song', description: '',
			budget: { type: 'count', count: 1 }, graphicsAssignment: { mode: 'add', presetId: overlay.id } });
		const first = randomUUID();
		const second = randomUUID();
		const switchTime = episodeDuration + songDuration;
		const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Metadata',
			defaultPreRoll: { presetId: preset.id, programId: musicProgram!.id },
			slots: [{ id: first, startSeconds: 0, programId: episodeProgram!.id }, { id: second, startSeconds: switchTime, programId: movieProgram!.id }],
			boundaries: [
				{ id: randomUUID(), leftSlotId: first, rightSlotId: second, targetSeconds: switchTime },
				{ id: randomUUID(), leftSlotId: second, rightSlotId: first, targetSeconds: SECONDS_PER_SCHEDULING_DAY },
			],
		}));
		const channel = await repository.createChannel(channelCreateSchema.parse({ name: 'Metadata TV', number: '73' }));
		await repository.setChannelSchedule(channel.id, channelScheduleConfigSchema.parse({ defaultTemplateId: template.id }));
		await timeline.runNow();
		const tomorrow = Temporal.Now.plainDateISO('UTC').add({ days: 1 });
		const records = await repository.listMaterializedTimelineSegments(
			tomorrow.toZonedDateTime('UTC').toInstant().toString(),
			tomorrow.add({ days: 1 }).toZonedDateTime('UTC').toInstant().toString(),
			channel.id,
		);
		const episodeRow = records.find(({ segment }) => segment.mediaItemId === episode.id)!;
		const fillerRow = records.find(({ segment }) => segment.role === 'filler' && segment.airing?.id === episodeRow.segment.airing?.id)!;
		const movieRow = records.find(({ segment }) => segment.mediaItemId === movie.id)!;
		const spans = [fillerRow.segment, episodeRow.segment, movieRow.segment];

		// Refresh the catalog while leaving the committed timeline available for graphics preparation.
		await song.scan('<musicvideo><title>Renamed song</title><artist>Current Artist</artist><album>Current album</album><track>8</track></musicvideo>');
		const catalogRead = vi.spyOn(repository, 'getSchedulingCatalogForItems');
		const prepare = () => preparePlayoutGraphicsLabels(repository, channel, spans, 'UTC', 'http://localhost', 2_000);
		const committed = (await prepare())?.contexts?.get(fillerRow.segment.id);
		const { context } = graphicsPreviewContextSchema.parse({ availability: 'available', context: committed });
		expect(catalogRead).toHaveBeenCalledTimes(1);
		expect(context.media).toMatchObject({ title: 'Song', artist: 'A & [credit]B[/credit]', artists: ['A & [credit]B[/credit]', 'Guest'],
			album: 'Night Signals', trackNumber: 4, discNumber: 2, edition: null, cast: [] });
		expect(context.now?.media).toMatchObject({ title: 'Rescue', seriesTitle: 'Alpine Series', seasonNumber: 1, episodeNumber: 3,
			artist: null, album: null, artists: [], genres: [] });
		expect(context.next?.media).toMatchObject({ title: 'Summit', originalTitle: 'Gipfel', edition: 'Extended Cut',
			genres: ['Adventure', 'Drama'], primaryGenre: 'Adventure', tags: ['Mountain'], certification: 'PG', rating: 7.5, userRating: 0,
			cast: [{ name: 'Ana Rivera', role: 'Climber' }, { name: 'Pat Reed', role: 'Guide' }],
			directors: ['Alex Chen'], writers: ['Jess King'], studios: ['Alpine Pictures'], countries: ['Canada'] });
		expect(context.upcoming[0]?.media).toEqual(context.next?.media);
		expect(JSON.stringify(committed)).not.toContain(root);

		const layer = parseGraphics(overlay.yaml).layers[0]!;
		expect(layer.kind).toBe('text');
		if (layer.kind !== 'text') {
			throw new Error('Expected the credit text layer');
		}
		const snapshots = await GraphicsSnapshots.open(path.join(root, 'snapshots'));
		const render = (source: string) => prepareGraphicsLayer(
			root,
			{ ...layer, text: source },
			new Map(),
			context,
			songDuration * 1_000,
			snapshots,
			{ width: 1920, height: 1080 },
		);
		const rendered = await render(layer.text);
		expect(rendered?.source.path).toBeTruthy();
		expect(rendered?.source.path).toBe((await render('A &amp; &#91;credit&#93;B&#91;/credit&#93;, Guest · Night Signals'))?.source.path);

		const captured = await repository.timelineMediaSnapshots([fillerRow.segment.id]);
		const { displayMetadata, ...legacy } = captured.get(fillerRow.segment.id)!;
		expect(displayMetadata?.album).toBe('Night Signals');
		await database.db.update(materializedTimelineSegments).set({ mediaSnapshot: { ...legacy, trackNumber: null } })
			.where(eq(materializedTimelineSegments.id, fillerRow.segment.id));
		const enriched = (await prepare())?.contexts?.get(fillerRow.segment.id)?.media;
		expect(enriched).toMatchObject({ title: 'Song', artist: 'A & [credit]B[/credit]', album: 'Current album', trackNumber: null, discNumber: 2 });
	}
	finally {
		await timeline.close();
		database.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
