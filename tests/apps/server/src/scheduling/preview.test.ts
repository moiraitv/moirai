import { DatabaseJobReader } from '@server/scheduling/database-jobs.js';
import { buildEtvPlayoutFiles } from '@server/playback/playout-output.js';
import { Temporal } from '@js-temporal/polyfill';
import { applyMaterializationWrite } from '@server/scheduling/materialization-writes.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
	channelScheduleDraftPreviewSchema, quickChannelSetupCreateSchema, scheduleTemplateCreateSchema, timelineDraftPreviewSchema,
	SECONDS_PER_SCHEDULING_DAY,
} from '@moirai/shared';
import { quickChannelSetupPreviewResultSchema } from '@moirai/shared/api-contracts';
import { createDatabase } from '@server/db/index.js';
import { openReadOnlyDatabase } from '@server/db/read-only.js';
import { guideTimelinePreview } from '@server/guide/preview.js';
import { Repository } from '@server/repository/index.js';
import { SchedulingRepository } from '@server/repository/scheduling.js';
import { schedulingRootProgramIds } from '@server/scheduling/catalog.js';
import { generateTimelineDetailed } from '@server/scheduling/engine.js';
import { PreviewExecutor, type PreviewRequest } from '@server/scheduling/preview.js';
import { schedulingProgramStatuses } from '@server/scheduling/status.js';
import { SchedulingQueueFullError, SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { publicError } from '@server/routes/public-errors.js';
import { fixture } from '../semantic/fixtures.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function setup() {
	const f = await fixture();
	cleanups.push(() => f.close());
	f.database.sqlite.exec('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000');
	f.repository.invalidateSchedulingCatalog();
	const workers = new SchedulingWorkerPool(1, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	return { ...f, workers };
}

async function template(f: Awaited<ReturnType<typeof setup>>, programId: string | null, name = 'Daily') {
	const slotId = randomUUID();
	return f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name,
		slots: [{ id: slotId, programId, startSeconds: 0, ...(programId === null ? { filler: { mode: 'disabled' } } : {}) }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY }],
	}));
}

function quick(f: Awaited<ReturnType<typeof setup>>): Extract<PreviewRequest, { kind: 'quick' }> {
	return { kind: 'quick', timeZone: 'UTC', startDate: '2026-09-19', maxExplicitMediaItems: 5_000,
		input: quickChannelSetupCreateSchema.parse({ scenario: 'movies', libraryId: f.library.id,
			programName: 'Movies', source: { type: 'library-query', genres: [] }, strategy: { type: 'sequential' },
			channel: { number: '2', name: 'Movies' } }),
	};
}

async function channel(f: Awaited<ReturnType<typeof setup>>, programId = f.source.id) {
	const base = await template(f, programId);
	return { kind: 'channel' as const, timeZone: 'UTC', input: channelScheduleDraftPreviewSchema.parse({
		channelId: f.channel.id, startDate: '2026-09-19', days: 1,
		schedule: { defaultTemplateId: base.id, layers: [] },
	}) };
}

it('matches independent generation for semantic programs, conditional layers, and filler without writes', async () => {
	const f = await setup();
	await f.embeddings();
	f.repository.invalidateSchedulingCatalog();
	const request = await channel(f, f.program.id);
	const layer = await template(f, f.source.id, 'Override');
	request.input.schedule.layers.push({
		id: randomUUID(), templateId: layer.id,
		predicate: { type: 'time-range', startSeconds: 3600, endSeconds: 7200, negated: false },
		entryBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left', earlyStartMaxDriftSeconds: 0 },
		exitBoundary: { policy: 'hard', maxDriftSeconds: 0, fallback: 'truncate-left', earlyStartMaxDriftSeconds: 0 },
	});
	request.input.schedule.defaultFiller = { programId: f.source.id, policy: 'best-fit-or-truncate' };
	const templates = await f.repository.listScheduleTemplates();
	const programs = await f.repository.listPrograms();
	const catalog = await f.repository.getSchedulingCatalog(programs, schedulingRootProgramIds(templates, [{ ...request.input.schedule, channelId: f.channel.id, createdAt: '', updatedAt: '' }]));
	const base = templates.find((item) => item.id === request.input.schedule.defaultTemplateId)!;
	const generated = generateTimelineDetailed({ channelId: f.channel.id, timeZone: request.timeZone,
		startDate: request.input.startDate, days: 1, schedule: { ...request.input.schedule, channelId: f.channel.id,
			createdAt: base.createdAt, updatedAt: base.updatedAt }, template: base, templates, programs, catalog, state: [] });
	const expected = guideTimelinePreview(generated, templates, programs);
	const before = f.database.sqlite.serialize();
	const result = await f.workers.preview(request);
	expect(result).toEqual(expected);
	expect(result.segments.some((segment) => segment.scheduleLayerId !== null)).toBe(true);
	expect(result.segments.some((segment) => segment.role === 'filler')).toBe(true);
	expect(f.database.sqlite.serialize()).toEqual(before);
}, 20_000);

it('matches the previous Quick Setup calculation and refreshes cached media after invalidation', async () => {
	const f = await setup();
	const request = quick(f);
	const { program, template: base, schedule, channel: draft } = f.repository.previewQuickChannelSetup(request.input, request.maxExplicitMediaItems);
	const libraryProgram = { ...program, id: '00000000-0000-4000-8000-000000000006' };
	const catalog = await f.repository.getSchedulingCatalog([program, libraryProgram]);
	const [library, programming] = schedulingProgramStatuses([libraryProgram, program], catalog);
	const generated = generateTimelineDetailed({ channelId: draft.id, timeZone: request.timeZone, startDate: request.startDate,
		days: 1, schedule, template: base, templates: [base], programs: [program], catalog, state: [] });
	const expected = quickChannelSetupPreviewResultSchema.parse({
		library: { items: library!.previewItems, indexedItemCount: library!.indexedItemCount },
		programming: { items: programming!.previewItems, indexedItemCount: programming!.indexedItemCount },
		templateName: base.name, schedule: generated,
	});
	const before = f.database.sqlite.serialize();
	expect(await f.workers.preview(request)).toEqual(expected);
	expect(await f.workers.preview(request)).toEqual(expected);
	expect(f.database.sqlite.serialize()).toEqual(before);

	f.database.sqlite.prepare('UPDATE media_items SET title=? WHERE id=?').run('Updated film', f.ids[0]);
	f.repository.invalidateSchedulingCatalog();
	const updated = await f.workers.preview(request);
	expect(updated.library.items.find((item) => item.id === f.ids[0])?.title).toBe('Updated film');
}, 20_000);

it('reads missing semantic preferences without queuing writes in either execution mode', async () => {
	const f = await setup();
	await f.embeddings();
	if (f.program.config.type !== 'similarity') {
		throw new Error('Expected similarity fixture');
	}
	await f.repository.updateProgram(f.program.id, { config: { ...f.program.config, softPreferences: 'Unprepared concept' } });
	const request = await channel(f, f.program.id);
	const local = new SchedulingWorkerPool(0, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => local.close());
	const before = f.database.sqlite.serialize();
	const result = await f.workers.preview(request);
	expect(result).toEqual(await local.preview(request));
	expect(f.database.sqlite.prepare('SELECT COUNT(*) AS count FROM semantic_preferences').get()).toEqual({ count: 0 });
	expect(f.database.sqlite.serialize()).toEqual(before);
}, 20_000);

it('uses a coherent read snapshot and releases it after success and missing-resource errors', async () => {
	const f = await setup();
	const request = await channel(f);
	const reader = openReadOnlyDatabase(f.database.sqlite.name);
	cleanups.push(() => reader.close());
	const executor = new PreviewExecutor(reader.db);
	const original = SchedulingRepository.prototype.listPrograms;
	const spy = vi.spyOn(SchedulingRepository.prototype, 'listPrograms').mockImplementationOnce(async function (this: SchedulingRepository) {
		f.database.sqlite.prepare('UPDATE media_items SET title=? WHERE id=?').run('Concurrent edit', f.ids[0]);
		return original.call(this);
	});
	const result = await executor.run({ request, revision: f.repository.schedulingCatalogRevision });
	spy.mockRestore();
	expect('segments' in result && result.segments.some((segment) => segment.title === 'Concurrent edit')).toBe(false);
	expect(reader.sqlite.inTransaction).toBe(false);
	f.repository.invalidateSchedulingCatalog();
	const next = await executor.run({ request, revision: f.repository.schedulingCatalogRevision });
	expect('segments' in next && next.segments.some((segment) => segment.title === 'Concurrent edit')).toBe(true);
	await expect(executor.run({ request: { ...request, input: { ...request.input, channelId: randomUUID() } }, revision: 100 }))
		.rejects.toMatchObject({ statusCode: 404 });
	expect(reader.sqlite.inTransaction).toBe(false);
});

it('preserves public missing-resource and validation errors and keeps the worker usable', async () => {
	const f = await setup();
	const request = await channel(f);
	const missing = await f.workers.preview({ ...request, input: { ...request.input, channelId: randomUUID() } }).catch((error: unknown) => error);
	expect(publicError(missing, 'missing')).toMatchObject({ statusCode: 404, body: { code: 'not_found' } });
	const invalid = quick(f);
	invalid.input.libraryId = randomUUID();
	const error = await f.workers.preview(invalid).catch((cause: unknown) => cause);
	expect(publicError(error, 'validation')).toMatchObject({ statusCode: 400, body: { code: 'validation_error' } });
	expect((await f.workers.preview(request)).segments.length).toBeGreaterThan(0);
	await f.workers.retireIdleWorkers();
	expect((await f.workers.preview(request)).segments.length).toBeGreaterThan(0);
}, 20_000);

it('keeps background catalogs isolated and shares capacity across both job kinds', async () => {
	const f = await setup();
	const request = quick(f);
	const resources = f.repository.previewQuickChannelSetup(request.input, request.maxExplicitMediaItems);
	const catalog = await f.repository.getSchedulingCatalog([resources.program]);
	const input = { channelId: resources.channel.id, timeZone: request.timeZone, startDate: request.startDate,
		days: 1, schedule: resources.schedule, template: resources.template, templates: [resources.template],
		programs: [resources.program], state: [], catalog: { ...catalog, cacheKey: 'background-test',
			media: catalog.media.map((item) => ({ ...item, title: 'Background snapshot' })) } };
	const workers = new SchedulingWorkerPool(1, 1, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	const expected = await workers.generate(input);
	expect(expected.segments[0]?.title).toBe('Background snapshot');
	const pending = workers.preview(request);
	await expect(workers.generate(input)).rejects.toBeInstanceOf(SchedulingQueueFullError);
	const preview = await pending;
	expect(preview.schedule.segments[0]?.title).not.toBe('Background snapshot');
	expect(await workers.generate(input)).toEqual(expected);

	const failed = workers.preview({ ...request, startDate: 'invalid-date' });
	await expect(failed).rejects.toMatchObject({ name: 'RangeError' });
	expect(await workers.preview(request)).toEqual(preview);
}, 20_000);

it('bounds preview admission and rejects pending work on shutdown', async () => {
	const f = await setup();
	const workers = new SchedulingWorkerPool(1, 1, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	const pending = workers.preview(quick(f));
	const rejected = expect(pending).rejects.toThrow('shut down');
	await expect(workers.preview({ ...quick(f), startDate: '2026-09-20' })).rejects.toBeInstanceOf(SchedulingQueueFullError);
	await workers.close();
	await rejected;
	await expect(workers.preview(quick(f))).rejects.toThrow('shutting down');
});

it('supports in-memory databases with workers enabled', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	cleanups.push(() => database.close());
	const repository = new Repository(database.db);
	const workers = new SchedulingWorkerPool(1, 4, { db: database.db, repository });
	cleanups.push(() => workers.close());
	const library = await repository.createLibrary({ name: 'Movies', typeKey: 'movies', sourceType: 'on-disk',
		sourceConfig: { scanRoot: '/media', playbackRoot: null }, scanIntervalMinutes: 15, watcherEnabled: false, enabled: true });
	const input = quickChannelSetupCreateSchema.parse({ scenario: 'movies', libraryId: library.id,
		programName: 'Movies', source: { type: 'library-query', genres: [] }, strategy: { type: 'sequential' },
		channel: { number: '1', name: 'Movies' } });
	const result = await workers.preview({ kind: 'quick', input, timeZone: 'UTC', startDate: '2026-09-19', maxExplicitMediaItems: 5_000 });
	expect(result.library.indexedItemCount).toBe(0);
	expect(result.schedule.issues.length).toBeGreaterThan(0);
	expect(await repository.listChannels()).toEqual([]);
});

it('matches serialized overview and template results without writing and invalidates read caches', async () => {
	const f = await setup();
	const request = await channel(f);
	const base = (await f.repository.listScheduleTemplates())[0]!;
	const local = new SchedulingWorkerPool(0, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => local.close());
	const before = f.database.sqlite.serialize();
	for (const read of [{ kind: 'overview' as const }, { kind: 'template' as const, timeZone: 'UTC',
		input: timelineDraftPreviewSchema.parse({ channelId: f.channel.id, template: base, startDate: request.input.startDate, days: 1 }) }]) {
		expect(JSON.parse((await f.workers.read(read)).body)).toEqual(JSON.parse((await local.read(read)).body));
	}
	expect(f.database.sqlite.serialize()).toEqual(before);
	await f.repository.updateProgram(f.source.id, { name: 'Renamed source' });
	f.workers.invalidateReads();
	expect(JSON.parse((await f.workers.read({ kind: 'overview' })).body).programs)
		.toContainEqual(expect.objectContaining({ id: f.source.id, name: 'Renamed source' }));
}, 20_000);

it('keeps interactive reads available while a background commit waits for its authoritative writer', async () => {
	const f = await setup();
	const base = await template(f, f.source.id);
	await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: base.id, layers: [], defaultFiller: null });
	const workers = new SchedulingWorkerPool(2, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let writes = 0;
	const background = workers.materialize('UTC', async () => {
		writes += 1;
		await gate;
	}, () => undefined);
	try {
		await vi.waitFor(() => expect(writes).toBeGreaterThan(0), { timeout: 10_000 });
		const result = await workers.read({ kind: 'overview' });
		expect(JSON.parse(result.body).channelSchedules).toHaveLength(1);
	}
	finally {
		release();
		await background;
	}
}, 20_000);

it('shares reads, cancels only abandoned queued work, and frees bounded queue capacity', async () => {
	const f = await setup();
	const base = await template(f, f.source.id);
	await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: base.id, layers: [], defaultFiller: null });
	const workers = new SchedulingWorkerPool(1, 2, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let writes = 0;
	const background = workers.materialize('UTC', async () => {
		writes += 1;
		await gate;
	}, () => undefined);
	try {
		await vi.waitFor(() => expect(writes).toBeGreaterThan(0), { timeout: 10_000 });
		const first = new AbortController();
		const second = new AbortController();
		const a = workers.read({ kind: 'overview' }, first.signal);
		const b = workers.read({ kind: 'overview' }, second.signal);
		const settled = Promise.allSettled([a, b]);
		first.abort();
		expect(() => workers.read({ kind: 'persisted', id: f.channel.id, timeZone: 'UTC', input: { days: 1 } }))
			.toThrow(SchedulingQueueFullError);
		second.abort();
		expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
		const replacement = workers.read({ kind: 'overview' });
		release();
		expect(JSON.parse((await replacement).body).channelSchedules).toHaveLength(1);
	}
	finally {
		release();
		await background;
	}
}, 20_000);

it('commits worker-prepared timelines through the owner and matches local guide and XMLTV reads', async () => {
	const f = await setup();
	const base = await template(f, f.source.id);
	await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: base.id, layers: [], defaultFiller: null });
	const before = await f.repository.listTimelineMaterializationStatuses();
	expect(before).toEqual([expect.objectContaining({ channelId: f.channel.id, health: 'generating' })]);
	const commands: string[] = [];
	await f.workers.materialize('UTC', async command => {
		commands.push(command.kind);
		await applyMaterializationWrite(f.repository, command);
	}, () => f.workers.invalidateReads());
	expect(commands).toContain('commit');
	expect(await f.repository.getTimelineMaterializationStatus(f.channel.id)).toMatchObject({ health: 'ready' });
	const local = new SchedulingWorkerPool(0, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => local.close());
	const startDate = Temporal.Now.plainDateISO('UTC').toString();
	for (const kind of ['guide', 'xmltv'] as const) {
		const request = { kind, timeZone: 'UTC', publicUrl: 'http://localhost:3000', startDate, days: 1 };
		const beforeRead = f.database.sqlite.serialize();
		expect((await f.workers.read(request)).body).toBe((await local.read(request)).body);
		expect(f.database.sqlite.serialize()).toEqual(beforeRead);
	}
}, 30_000);

it('gives queued background work a turn after three interactive jobs with one worker', async () => {
	const f = await setup();
	const base = await template(f, f.source.id);
	await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: base.id, layers: [], defaultFiller: null });
	const workers = new SchedulingWorkerPool(1, 8, { db: f.database.db, repository: f.repository });
	cleanups.push(() => workers.close());
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	let waiting = false;
	const first = workers.materialize('UTC', async () => {
		waiting = true;
		await gate;
	}, () => undefined);
	const order: string[] = [];
	try {
		await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 10_000 });
		const background = workers.materialize('UTC', async () => {
			order.push('background');
		}, () => undefined);
		const reads = [1, 2, 3, 4].map(days => workers.read({ kind: 'persisted', id: f.channel.id,
			timeZone: 'UTC', input: { days } }).then(() => {
			order.push(`read-${days}`);
		}));
		release();
		await Promise.all([first, background, ...reads]);
		expect(order).toEqual(['read-1', 'read-2', 'read-3', 'background', 'read-4']);
	}
	finally {
		release();
		await first;
	}
}, 30_000);

it('uses a coherent overview snapshot and releases it after the read', async () => {
	const f = await setup();
	const reader = openReadOnlyDatabase(f.database.sqlite.name);
	cleanups.push(() => reader.close());
	const executor = new DatabaseJobReader(reader.db);
	const original = Repository.prototype.listScheduleTemplates;
	vi.spyOn(Repository.prototype, 'listScheduleTemplates').mockImplementationOnce(async function (this: Repository) {
		const templates = await original.call(this);
		f.database.sqlite.prepare('UPDATE media_items SET title=? WHERE id=?').run('Concurrent overview edit', f.ids[0]);
		return templates;
	});
	const first = JSON.parse((await executor.read({ kind: 'overview' }, '1:0')).body);
	expect(first.programStatuses.find((status: { programId: string }) => status.programId === f.source.id).previewItems[0].title)
		.not.toBe('Concurrent overview edit');
	expect(reader.sqlite.inTransaction).toBe(false);
	const next = JSON.parse((await executor.read({ kind: 'overview' }, '2:0')).body);
	expect(next.programStatuses.find((status: { programId: string }) => status.programId === f.source.id).previewItems[0].title)
		.toBe('Concurrent overview edit');
});

it('preserves exact fallback playout output for an unassigned channel in workers', async () => {
	const f = await setup();
	const guide = { timeZone: 'UTC', startDate: '2026-09-19', requestedDays: 2, days: 2,
		segmentLimitApplied: false, channels: [] };
	const input: Parameters<typeof buildEtvPlayoutFiles> = [[f.channel], guide,
		new Map([[f.channel.id, { path: '/fallback.mp4', durationMilliseconds: 161_000, hasAudio: false }]])];
	expect(await f.workers.playout(input)).toEqual(buildEtvPlayoutFiles(...input));
	expect(await f.repository.getChannelSchedule(f.channel.id)).toBeNull();
	expect(await f.repository.getTimelineMaterialization(f.channel.id)).toBeNull();
}, 20_000);

it('matches semantic ranking in workers and reports missing draft preparation without writes', async () => {
	const f = await setup();
	await f.embeddings();
	f.repository.invalidateSchedulingCatalog();
	if (f.program.config.type !== 'similarity') {
		throw new Error('Expected similarity program');
	}
	const local = new SchedulingWorkerPool(0, 4, { db: f.database.db, repository: f.repository });
	cleanups.push(() => local.close());
	const before = f.database.sqlite.serialize();
	const request = { kind: 'similarity' as const, config: { ...f.program.config, softPreferences: 'A new draft concept' } };
	const result = await f.workers.read(request);
	expect(result).toEqual(await local.read(request));
	expect(result.preferences).toContain('A new draft concept');
	expect(f.database.sqlite.serialize()).toEqual(before);
}, 20_000);
