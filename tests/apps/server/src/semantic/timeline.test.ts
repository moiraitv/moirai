import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { scheduleTemplateCreateSchema, type SelectionStateRecord } from '@moirai/shared';
import { generateTimelineDetailed, type GenerateTimelineInput } from '@server/scheduling/engine.js';
import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { SemanticPreferenceRepository } from '@server/repository/semantic-preferences.js';
import { fixture, vector } from './fixtures.js';

it('commits every seed generation with real timeline deltas and replays identical decisions in a worker', async () => {
	const f = await fixture();
	const workers = new SchedulingWorkerPool(1, 4);
	try {
		await f.embeddings();
		f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000').run();
		f.repository.invalidateSchedulingCatalog();
		const slotId = randomUUID();
		const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Semantic day',
			slots: [{ id: slotId, programId: f.program.id, startSeconds: 0, stateScope: 'occurrence' }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
		}));
		const context = await f.context();
		const input: GenerateTimelineInput = { channelId: f.channel.id, timeZone: 'UTC', startDate: '2026-09-19', days: 2,
			template, templates: [template], schedule: { channelId: f.channel.id, defaultTemplateId: template.id, layers: [], defaultFiller: null, createdAt: template.createdAt, updatedAt: template.updatedAt }, programs: [...context.programs.values()], catalog: context.catalog, state: [] };
		const result = generateTimelineDetailed(input);
		expect(result.segments.filter((segment) => segment.role === 'primary')).toHaveLength(8);
		const transitions = new Map(result.stateTransitions.map((transition) => [transition.segmentId, transition.stateDelta]));
		f.repository.commitMaterializedTimeline({ channelId: f.channel.id, expectedRevision: 0, windowStart: '2026-09-19T00:00:00Z',
			windowEnd: '2026-09-21T00:00:00Z', replaceFrom: '2026-09-19T00:00:00Z', continuationAt: result.continuationAt,
			inputFingerprint: 'timeline-test', baseState: [], finalState: result.proposedState, issues: result.issues,
			committedAt: '2026-09-19T00:00:00Z', segments: result.segments.map((segment) => ({ segment, mediaSnapshot: null,
				stateDelta: transitions.get(segment.id) ?? [] })),
		});
		expect(f.semantic.seeds().map((seed) => seed.generation)).toEqual([1, 2, 3]);
		f.reopen();
		const catalog = (await f.context()).catalog;
		catalog.semantic!.vectors = {};
		const replay = await workers.generate({ ...input, catalog });
		expect(replay.segments.map((segment) => segment.mediaItemId)).toEqual(result.segments.map((segment) => segment.mediaItemId));
		f.semantic.pruneSeeds();
		expect(f.semantic.seeds()).toHaveLength(3);
		const final = result.proposedState.find((record) => record.value.type === 'similarity')!;
		if (final.value.type !== 'similarity') {
			throw new Error('Expected similarity state');
		}
		expect(final.value.consumedItemIds).toHaveLength(2);
		expect(final.consumerKey).not.toMatch(/2026-09/);
		const stored: SelectionStateRecord[] = await f.repository.getSelectionState(f.channel.id);
		expect(stored).toEqual(result.proposedState);
	}
	finally {
		await workers.close();
		await f.close();
	}
});

it('refreshes a reused worker when a saved refinement was already embedded', async () => {
	const f = await fixture();
	const workers = new SchedulingWorkerPool(1, 4);
	try {
		await f.embeddings();
		f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000').run();
		const preferences = new SemanticPreferenceRepository(f.database.db);
		preferences.catalog(['space']);
		for (const input of preferences.pending()) {
			preferences.store(input.hash, vector());
		}
		f.repository.invalidateSchedulingCatalog();
		const slotId = randomUUID();
		const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Day',
			slots: [{ id: slotId, programId: f.program.id, startSeconds: 0 }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
		}));
		const context = await f.context();
		const input: GenerateTimelineInput = { channelId: f.channel.id, timeZone: 'UTC', startDate: '2026-09-19', days: 1,
			template, templates: [template], schedule: { channelId: f.channel.id, defaultTemplateId: template.id, layers: [], defaultFiller: null, createdAt: template.createdAt, updatedAt: template.updatedAt }, programs: [...context.programs.values()], catalog: context.catalog, state: [] };
		expect((await workers.generate(input)).segments.filter((segment) => segment.role === 'primary')).toHaveLength(4);
		for (const refinement of [{ softPreferences: 'space' }, { hardExclusions: ['space'] }]) {
			await f.repository.updateProgram(f.program.id, { config: { ...f.program.config, ...refinement } });
			const updated = await f.context();
			const next = { ...input, programs: [...updated.programs.values()], catalog: updated.catalog };
			expect(next.catalog.cacheKey).not.toBe(input.catalog.cacheKey);
			const expected = generateTimelineDetailed(next);
			const actual = await workers.generate(next);
			expect(actual.segments.map((segment) => segment.mediaItemId)).toEqual(expected.segments.map((segment) => segment.mediaItemId));
			expect(actual.issues).toEqual(expected.issues);
		}
	}
	finally {
		await workers.close();
		await f.close();
	}
});

it('replays each Program scope in a reused worker when media membership is identical', async () => {
	const f = await fixture();
	const workers = new SchedulingWorkerPool(1, 4);
	try {
		await f.embeddings();
		f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000').run();
		const other = await f.repository.createProgram({ name: 'Other similar', config: f.program.config });
		const slotId = randomUUID();
		const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Scoped day',
			slots: [{ id: slotId, programId: f.program.id, startSeconds: 0 }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
		}));
		const context = await f.context();
		const input: GenerateTimelineInput = { channelId: f.channel.id, timeZone: 'UTC', startDate: '2026-09-19', days: 1,
			template, templates: [template], schedule: { channelId: f.channel.id, defaultTemplateId: template.id, layers: [], defaultFiller: null, createdAt: template.createdAt, updatedAt: template.updatedAt }, programs: [...context.programs.values()], catalog: context.catalog, state: [] };
		const initial = generateTimelineDetailed(input);
		const first = initial.stateTransitions[0]!.stateDelta.find((record) => record.value.type === 'similarity')!;
		const second = structuredClone(first);
		if (second.value.type !== 'similarity') {
			throw new Error('Expected similarity state');
		}
		// Persist distinct decisions with identical membership to exercise scoped catalog identity.
		second.consumerKey = second.consumerKey.replace(f.program.id, other.id);
		second.value.seed.consumerKey = second.consumerKey;
		second.value.seed.programId = other.id;
		second.value.seed.itemIds.reverse();
		second.value.consumedItemIds = [second.value.seed.itemIds[0]!];
		f.commit([first, second]);
		f.reopen();
		const programs = await f.repository.listPrograms();
		const a = await f.repository.getSchedulingCatalog(programs, [f.program.id]);
		const b = await f.repository.getSchedulingCatalog(programs, [other.id]);
		expect(a.media.map((media) => media.id)).toEqual(b.media.map((media) => media.id));
		expect(a.semantic!.seeds[0]!.itemIds).toEqual([...b.semantic!.seeds[0]!.itemIds].reverse());
		const otherTemplate = { ...template, slots: template.slots.map((slot) => ({ ...slot, programId: other.id })) };
		for (const next of [{ ...input, catalog: a }, { ...input, template: otherTemplate, templates: [otherTemplate], catalog: b }, { ...input, catalog: a }]) {
			const direct = generateTimelineDetailed(next);
			const worker = await workers.generate(next);
			expect(worker.segments.map((segment) => segment.mediaItemId)).toEqual(direct.segments.map((segment) => segment.mediaItemId));
			expect(worker.proposedState).toEqual(direct.proposedState);
		}
		expect(a.cacheKey).not.toBe(b.cacheKey);
		expect((await f.repository.getSchedulingCatalog([...programs].reverse(), [f.program.id])).cacheKey).toBe(a.cacheKey);
	}
	finally {
		await workers.close();
		await f.close();
	}
});
