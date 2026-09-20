import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { channelCreateSchema, scheduleTemplateCreateSchema } from '@moirai/shared';
import { selectProgram } from '@server/scheduling/selection.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';
import { SemanticPreferenceRepository } from '@server/repository/semantic-preferences.js';
import { vector, fixture } from './fixtures.js';

async function schedule(f: Awaited<ReturnType<typeof fixture>>, programId: string) {
	const slotId = randomUUID();
	const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily',
		slots: [{ id: slotId, programId, startSeconds: 0 }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }],
	}));
	await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: template.id, layers: [], defaultFiller: null });
	f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000').run();
	f.repository.invalidateSchedulingCatalog();
	return template;
}

it('keeps independent nested Program seeds when an existing sequence entry is reassigned', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const other = await f.repository.createProgram({ name: 'Second', config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 1, variety: 0 } });
		const entryId = randomUUID();
		const config = (programId: string) => ({ type: 'sequence' as const, entries: [{ id: entryId, programId, count: 1 }], repeat: true });
		const sequence = await f.repository.createProgram({ name: 'Parent', config: config(f.program.id) });
		const first = selectProgram(sequence.id, 'parent-consumer', new Map(), await f.context())!;
		f.commit([...first.state.values()]);
		await f.repository.updateProgram(sequence.id, { config: config(other.id) });
		const next = selectProgram(sequence.id, 'parent-consumer', first.state, await f.context())!;
		const states = [...next.state.values()].filter((record) => record.value.type === 'similarity');
		expect(states.map((record) => record.value.type === 'similarity' && record.value.seed.programId)).toEqual(expect.arrayContaining([other.id, f.program.id]));
		const otherState = states.find((record) => record.value.type === 'similarity' && record.value.seed.programId === other.id)!;
		expect(otherState.value.type === 'similarity' && otherState.value.seed.itemIds).toHaveLength(1);
		await f.repository.updateProgram(sequence.id, { config: config(f.program.id) });
		const resumed = selectProgram(sequence.id, 'parent-consumer', next.state, await f.context())!;
		const original = [...resumed.state.values()].find((record) => record.value.type === 'similarity' && record.value.seed.programId === f.program.id)!;
		expect(original.value.type === 'similarity' && original.value.consumedItemIds).toHaveLength(2);
	}
	finally {
		await f.close();
	}
});

it('recovers semantic dead air when media availability returns, without an authored edit', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await f.embeddings();
		await schedule(f, f.program.id);
		f.database.sqlite.prepare("UPDATE media_items SET availability='unconfirmed'").run();
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		const first = await f.repository.getTimelineMaterialization(f.channel.id);
		expect(first?.health).toBe('ready');
		expect(first?.issues.some((issue) => issue.code === 'source-unavailable')).toBe(true);
		f.database.sqlite.prepare("UPDATE media_items SET availability='available'").run();
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		const segments = await f.repository.listMaterializedTimelineSegments('2026-09-19T12:00:00Z', '2026-09-20T00:00:00Z', f.channel.id);
		expect(segments.some((record) => record.segment.role === 'primary')).toBe(true);
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});

it('ignores embedding preparation for a Content-only channel with an unused Similar Items Program', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await schedule(f, f.source.id);
		await materializer.runNow(true);
		const before = await f.repository.getTimelineMaterialization(f.channel.id);
		expect(before?.health).toBe('ready');
		await f.embeddings();
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		const after = await f.repository.getTimelineMaterialization(f.channel.id);
		expect(after?.health).toBe('ready');
		expect(after?.revision).toBe(before?.revision);
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});

it('commits new timelines after removing and deleting a Similar Items Program with retained checkpoints', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await f.embeddings();
		const template = await schedule(f, f.program.id);
		await materializer.runNow(true);
		expect((await f.repository.getTimelineMaterialization(f.channel.id))?.health).toBe('ready');
		expect(f.semantic.seeds().length).toBeGreaterThan(0);
		await f.repository.updateScheduleTemplate(template.id, { slots: template.slots.map((slot) => ({ ...slot, programId: f.source.id })) });
		expect(await f.repository.deleteProgram(f.program.id)).toBe(true);
		await materializer.applyNow(f.channel.id);
		const current = await f.repository.getTimelineMaterialization(f.channel.id);
		expect(current?.lastError).toBeNull();
		expect(current?.health).toBe('ready');
		expect(f.semantic.seeds()).toEqual([]);
		f.reopen();
		expect((await f.repository.getTimelineMaterialization(f.channel.id))?.health).toBe('ready');
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});

it('blocks a sequence while similarity embeddings or remaining seed items are unavailable', async () => {
	const f = await fixture();
	try {
		const sequence = await f.repository.createProgram({ name: 'Blocked sequence', config: { type: 'sequence', repeat: true,
			entries: [{ id: randomUUID(), programId: f.program.id, count: 3 }, { id: randomUUID(), programId: f.source.id, count: 1 }] } });
		const pending = await f.context();
		expect(selectProgram(sequence.id, f.key, new Map(), pending)).toBeNull();
		expect(pending.blockedPrograms.has(sequence.id)).toBe(true);
		await f.embeddings();
		f.repository.invalidateSchedulingCatalog();
		const first = selectProgram(sequence.id, f.key, new Map(), await f.context())!;
		const context = await f.context();
		context.catalog.semantic!.unavailableItems = Object.fromEntries(f.ids.filter((id) => id !== f.ids[0]).map((id) => [id, true]));
		const before = structuredClone(first.state);
		expect(selectProgram(sequence.id, f.key, first.state, context)).toBeNull();
		expect(first.state).toEqual(before);
		expect(context.blockedPrograms.has(sequence.id)).toBe(true);
		context.catalog.semantic!.unavailableItems = {};
		context.blockedPrograms.clear();
		const resumed = selectProgram(sequence.id, f.key, first.state, context)!;
		expect(resumed.programAncestry).toContain(f.program.id);
		expect(resumed.state.get(f.key)?.value).toMatchObject({ selectedInEntry: 2 });
	}
	finally {
		await f.close();
	}
});

it('clears only the deleted channel schedule seeds and uses current settings when reassigned', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await f.embeddings();
		const template = await schedule(f, f.program.id);
		const other = await f.repository.createChannel(channelCreateSchema.parse({ number: '2', name: 'Other channel' }));
		const assignment = { defaultTemplateId: template.id, layers: [], defaultFiller: null };
		await f.repository.setChannelSchedule(other.id, assignment);
		await materializer.runNow(true);
		const original = f.semantic.seeds();
		const owned = new Set(original.filter((seed) => seed.consumerKey.includes(f.channel.id)).map((seed) => seed.consumerKey));
		const otherSeeds = original.filter((seed) => seed.consumerKey.includes(other.id));
		expect(owned.size).toBeGreaterThan(0);
		expect(otherSeeds.length).toBeGreaterThan(0);
		await f.repository.updateProgram(f.program.id, { config: { type: 'similarity', sourceProgramId: f.source.id, quantity: 1, variety: 35 } });
		const programs = await f.repository.listPrograms();
		const warm = await f.repository.getSchedulingCatalog(programs);
		expect(warm.semantic!.seeds.some((seed) => owned.has(seed.consumerKey))).toBe(true);

		expect(await f.repository.deleteChannelSchedule(f.channel.id)).toBe(true);
		expect(f.semantic.seeds()).toEqual(otherSeeds);
		expect(await f.repository.getSelectionState(f.channel.id)).toEqual([]);
		const cleared = await f.repository.getSchedulingCatalog(programs);
		expect(cleared.semantic!.seeds).toEqual(otherSeeds);
		expect(cleared.semantic!.currentSets?.some((set) => owned.has(set.consumerKey))).toBe(false);
		await f.repository.setChannelSchedule(f.channel.id, assignment);
		await materializer.runNow(true);
		const regenerated = f.semantic.seeds().filter((seed) => owned.has(seed.consumerKey));
		expect(regenerated.length).toBeGreaterThan(0);
		expect(regenerated.every((seed) => seed.config.quantity === 1 && seed.itemIds.length === 1)).toBe(true);
		expect(f.semantic.seeds().filter((seed) => seed.consumerKey.includes(other.id))).toEqual(otherSeeds);
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});


it('recovers a Theme schedule after its theme embedding becomes ready without an authored edit', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await f.embeddings();
		const theme = await f.repository.createProgram({ name: 'Theme', config: { type: 'theme', libraryId: f.library.id, theme: 'Space', variety: 35, quantity: 3 } });
		await schedule(f, theme.id);
		await materializer.runNow(true);
		const segments = () => f.repository.listMaterializedTimelineSegments('2026-09-19T12:00:00Z', '2026-09-20T00:00:00Z', f.channel.id);
		expect((await segments()).some((record) => record.segment.role === 'primary')).toBe(false);
		const preferences = new SemanticPreferenceRepository(f.database.db);
		for (const job of preferences.pending()) {
			preferences.store(job.hash, vector());
		}
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		expect((await segments()).some((record) => record.segment.role === 'primary')).toBe(true);
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});
