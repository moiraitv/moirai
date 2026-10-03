import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { BUILTIN_MID_ROLL_PRESETS, SECONDS_PER_SCHEDULING_DAY, channelCreateSchema,
	midRollPresetCreateSchema, scheduleTemplateCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});
function repository(): Repository {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	return new Repository(database.db);
}
function draft(name = 'Shared breaks') {
	return midRollPresetCreateSchema.parse({ ...BUILTIN_MID_ROLL_PRESETS[0], name });
}

it('seeds protected examples and validates custom names without raw database errors', async () => {
	const repo = repository();
	expect((await repo.midRollPresets.list()).map(preset => preset.id).sort()).toEqual(BUILTIN_MID_ROLL_PRESETS.map(preset => preset.id).sort());
	const builtin = BUILTIN_MID_ROLL_PRESETS[0]!;
	await expect(repo.midRollPresets.save(draft(), builtin.id)).rejects.toMatchObject({ statusCode: 409 });
	await expect(repo.midRollPresets.delete(builtin.id)).rejects.toMatchObject({ statusCode: 409 });
	const saved = await repo.midRollPresets.save(draft());
	await expect(repo.midRollPresets.save(draft('SHARED BREAKS'))).rejects.toThrow('with that name');
	expect(saved.preset.isBuiltin).toBe(false);
	expect(repo.midRollPresets.settings([saved.preset.id])[saved.preset.id]?.budget).toEqual(saved.preset.budget);
	expect(() => repo.midRollPresets.settings([randomUUID()])).toThrow('does not exist');
});

it('distinguishes behavior changes from name and description changes', async () => {
	const repo = repository();
	const { preset } = await repo.midRollPresets.save(draft());
	expect((await repo.midRollPresets.save(draft('Renamed'), preset.id)).behaviorChanged).toBe(false);
	expect((await repo.midRollPresets.save({ ...draft('Renamed'), description: 'Different description' }, preset.id)).behaviorChanged).toBe(false);
	expect((await repo.midRollPresets.save({ ...draft('Renamed'), budget: { type: 'count', count: 2 } }, preset.id)).behaviorChanged).toBe(true);
});

it('validates assignments and protects all direct references until detached', async () => {
	const repo = repository();
	const { preset } = await repo.midRollPresets.save(draft());
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Assigned' }));
	const program = await repo.createProgram({ name: 'Source', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } } });
	const slotId = randomUUID();
	const assignment = { presetId: preset.id, programId: program.id };
	const input = scheduleTemplateCreateSchema.parse({ name: 'Daily', defaultMidRoll: assignment,
		slots: [{ id: slotId, startSeconds: 0, programId: program.id, midRoll: { mode: 'configured', config: assignment } }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }] });
	await expect(repo.createScheduleTemplate({ ...input, defaultMidRoll: { ...assignment, presetId: randomUUID() } })).rejects.toThrow('does not exist');
	const template = await repo.createScheduleTemplate(input);
	await repo.setChannelSchedule(channel.id, { defaultTemplateId: template.id, defaultProgramId: null, layers: [], defaultFiller: null, defaultMidRoll: assignment });
	const usage = await repo.resourceUsage('mid-roll-preset', preset.id, 1, 50);
	expect(usage?.total).toBe(2);
	expect(usage?.items.find(entry => entry.id === template.id)).toMatchObject({ referenceCount: 2 });
	await expect(repo.midRollPresets.delete(preset.id)).rejects.toThrow('in use');
	await expect(repo.deleteProgram(program.id)).rejects.toThrow();
	await repo.setChannelSchedule(channel.id, { defaultTemplateId: template.id, defaultProgramId: null, layers: [], defaultFiller: null, defaultMidRoll: null });
	await repo.updateScheduleTemplate(template.id, { defaultMidRoll: null, slots: template.slots.map(slot => ({ ...slot, midRoll: { mode: 'disabled' } })) });
	await expect(repo.midRollPresets.delete(preset.id)).resolves.toBeUndefined();
});

it('loads updated behavior with a new worker cache identity while metadata edits preserve it', async () => {
	const repo = repository();
	const { preset } = await repo.midRollPresets.save(draft());
	const first = await repo.getSchedulingCatalog([], [], [preset.id]);
	await repo.midRollPresets.save(draft('Renamed'), preset.id);
	expect((await repo.getSchedulingCatalog([], [], [preset.id])).cacheKey).toBe(first.cacheKey);
	await repo.midRollPresets.save({ ...draft('Renamed'), budget: { type: 'count', count: 2 } }, preset.id);
	const changed = await repo.getSchedulingCatalog([], [], [preset.id]);
	expect(changed.cacheKey).not.toBe(first.cacheKey);
	expect(changed.midRollPresets?.[preset.id]?.budget).toEqual({ type: 'count', count: 2 });
});

it('supports immutable filler kinds and names scoped to each kind', async () => {
	const repo = repository();
	const pre = await repo.fillerPresets.save({ kind: 'pre-roll', name: 'Bumper', description: '', budget: { type: 'count', count: 1 } });
	await expect(repo.fillerPresets.save({ kind: 'post-roll', name: 'BUMPER', description: '', budget: { type: 'count', count: 1 } })).resolves.toBeDefined();
	await expect(repo.fillerPresets.save({ kind: 'pre-roll', name: 'BUMPER', description: '', budget: { type: 'count', count: 1 } })).rejects.toThrow('with that name');
	await expect(repo.fillerPresets.save({ kind: 'tail', name: 'Bumper', description: '', budget: { type: 'count', count: 1 } }, pre.preset.id)).rejects.toThrow('type cannot be changed');
});
it('rejects wrong-kind assignments and protects pre/post references in usage and deletion', async () => {
	const repo = repository();
	const preset = (await repo.fillerPresets.save({ kind: 'pre-roll', name: 'Intro', description: '', budget: { type: 'count', count: 1 } })).preset;
	const program = await repo.createProgram({ name: 'Intro source', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } } });
	const slotId = randomUUID();
	const assignment = { presetId: preset.id, programId: program.id };
	const input = scheduleTemplateCreateSchema.parse({ name: 'Intro template', defaultPreRoll: assignment,
		slots: [{ id: slotId, startSeconds: 0, programId: program.id, preRoll: { mode: 'configured', config: assignment } }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }] });
	await expect(repo.createScheduleTemplate({ ...input, defaultPostRoll: assignment })).rejects.toThrow('assignment type');
	const template = await repo.createScheduleTemplate(input);
	expect(template.defaultPreRoll).toEqual(assignment);
	expect(template.slots[0]!.preRoll).toEqual({ mode: 'configured', config: assignment });
	expect((await repo.resourceUsage('filler-preset', preset.id, 1, 50))?.items[0]?.referenceCount).toBe(2);
	await expect(repo.fillerPresets.delete(preset.id)).rejects.toThrow('in use');
});

it('rejects Sequence sources in every filler assignment while retaining primary Sequence support', async () => {
	const repo = repository();
	const leaf = await repo.createProgram({ name: 'Leaf', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } } });
	const sequence = await repo.createProgram({ name: 'Sequence', config: { type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: leaf.id, count: 1 }] } });
	const slotId = randomUUID();
	const input = scheduleTemplateCreateSchema.parse({ name: 'Sequence primary', slots: [{ id: slotId, startSeconds: 0, programId: sequence.id }],
		boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY, policy: 'hard' }] });
	const template = await repo.createScheduleTemplate(input);
	const channel = await repo.createChannel(channelCreateSchema.parse({ name: 'Sequence primary', number: '99' }));
	const assignment = { programId: sequence.id, presetId: BUILTIN_MID_ROLL_PRESETS[0]!.id, policy: 'next-fit-only' as const };
	for (const field of ['defaultPreRoll', 'defaultMidRoll', 'defaultPostRoll', 'defaultFiller'] as const) {
		await expect(repo.createScheduleTemplate({ ...input, [field]: assignment })).rejects.toThrow('Sequence Programs');
		await expect(repo.updateScheduleTemplate(template.id, { [field]: assignment })).rejects.toThrow('Sequence Programs');
	}
	for (const field of ['preRoll', 'midRoll', 'postRoll', 'filler'] as const) {
		await expect(repo.updateScheduleTemplate(template.id, { slots: [{ ...input.slots[0]!, [field]: { mode: 'configured', config: assignment } }] })).rejects.toThrow('Sequence Programs');
	}
	for (const field of ['defaultPreRoll', 'defaultMidRoll', 'defaultPostRoll', 'defaultTailFiller', 'defaultFiller'] as const) {
		await expect(repo.setChannelSchedule(channel.id, { defaultTemplateId: template.id, defaultProgramId: null, layers: [], defaultFiller: null,
			[field]: assignment })).rejects.toThrow('Sequence Programs');
	}
	await expect(repo.setChannelSchedule(channel.id, { defaultTemplateId: null, defaultProgramId: sequence.id, layers: [], defaultFiller: null })).resolves.toMatchObject({ defaultProgramId: sequence.id });
	expect((await repo.getScheduleTemplate(template.id))?.defaultMidRoll).toBeNull();
});
