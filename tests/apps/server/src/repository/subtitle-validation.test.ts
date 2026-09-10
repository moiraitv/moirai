import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { channelCreateSchema, channelScheduleConfigSchema, scheduleTemplateCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close(); 
	} 
});

it('accepts inherited credits on Convert channels while preserving explicit overrides', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const repository = new Repository(database.db);
	const credit = await repository.creditTemplates.save({ description: '', name: 'Credits', source: 'unused in this persistence test' });
	const leaf = await repository.createProgram({ name: 'Leaf', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } } });
	const sequence = await repository.createProgram({ name: 'Sequence', config: { type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: leaf.id, count: 1 }], subtitlePreferences: { creditsTemplateId: credit.id } } });
	const slotId = randomUUID();
	const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily', boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400, policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' }], slots: [{ id: slotId, startSeconds: 0, programId: sequence.id }] }));
	const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Converted', subtitleMode: 'convert' }));
	const schedule = channelScheduleConfigSchema.parse({ defaultTemplateId: template.id });
	await expect(repository.setChannelSchedule(channel.id, schedule)).resolves.toBeTruthy();
	await repository.updateProgram(leaf.id, { config: { ...leaf.config, subtitlePreferences: { creditsTemplateId: null } } });
	await expect(repository.setChannelSchedule(channel.id, schedule)).resolves.toMatchObject({ channelId: channel.id });
	await expect(repository.updateProgram(leaf.id, { config: { ...leaf.config, subtitlePreferences: {} } })).resolves.toBeTruthy();
	await expect(repository.creditTemplates.delete(credit.id)).rejects.toThrow('Sequence');
});

it('rejects missing template references before persisting programs', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const repository = new Repository(database.db);
	await expect(repository.createProgram({ name: 'Invalid', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' }, subtitlePreferences: { creditsTemplateId: randomUUID() } } })).rejects.toThrow('does not exist');
	expect(await repository.listPrograms()).toEqual([]);
});

async function fixture() {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const repository = new Repository(database.db);
	const leaf = await repository.createProgram({ name: 'Leaf', config: { type: 'content', source: { type: 'item', itemId: randomUUID() }, strategy: { type: 'sequential' } } });
	return { database, repository, leaf };
}

async function assign(repository: Repository, programId: string) {
	const slotId = randomUUID();
	const template = await repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily', boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400, policy: 'hard', maxDriftSeconds: 0, fallback: 'reject-start' }], slots: [{ id: slotId, startSeconds: 0, programId }] }));
	const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Converted', subtitleMode: 'convert' }));
	return repository.setChannelSchedule(channel.id, channelScheduleConfigSchema.parse({ defaultTemplateId: template.id }));
}

it('skips subtitle graph reads for template edits that preserve program references', async () => {
	const { database, repository, leaf } = await fixture();
	await assign(repository, leaf.id);
	const template = (await repository.listScheduleTemplates())[0]!;
	const prepare = vi.spyOn(database.sqlite, 'prepare');
	await repository.updateScheduleTemplate(template.id, { name: 'Renamed', slots: template.slots });
	expect(prepare.mock.calls.some(([sql]) => /select .* from "channels"/i.test(sql))).toBe(false);
	prepare.mockRestore();
	const credit = await repository.creditTemplates.save({ description: '', name: 'Credits', source: 'unused' });
	const credited = await repository.createProgram({ name: 'Credited', config: { ...leaf.config, subtitlePreferences: { creditsTemplateId: credit.id } } });
	await expect(repository.updateScheduleTemplate(template.id, { slots: template.slots.map((slot) => ({ ...slot, programId: credited.id })) })).resolves.toBeTruthy();
});

it('skips global assignment reads for renames and content strategy changes', async () => {
	const { database, repository, leaf } = await fixture();
	await assign(repository, leaf.id);
	if (leaf.config.type !== 'content') {
		throw new Error('Expected content fixture');
	}
	const prepare = vi.spyOn(database.sqlite, 'prepare');
	try {
		await repository.updateProgram(leaf.id, { name: 'Renamed', config: leaf.config });
		await repository.updateProgram(leaf.id, { config: { ...leaf.config, strategy: { type: 'random', seed: '' } } });
		expect(prepare.mock.calls.some(([sql]) => /select .* from "channels"/i.test(sql))).toBe(false);
	}
	finally {
		prepare.mockRestore();
	}
});

it('accepts changed sequence references while ignoring entry counts', async () => {
	const { database, repository, leaf } = await fixture();
	const sequence = await repository.createProgram({ name: 'Sequence', config: { type: 'sequence', repeat: true, entries: [{ id: randomUUID(), programId: leaf.id, count: 1 }] } });
	await assign(repository, sequence.id);
	if (sequence.config.type !== 'sequence') {
		throw new Error('Expected sequence fixture');
	}
	const prepare = vi.spyOn(database.sqlite, 'prepare');
	try {
		await repository.updateProgram(sequence.id, { config: { ...sequence.config, entries: sequence.config.entries.map((entry) => ({ ...entry, count: 2 })) } });
		expect(prepare.mock.calls.some(([sql]) => /select .* from "channels"/i.test(sql))).toBe(false);
	}
	finally {
		prepare.mockRestore();
	}
	const credit = await repository.creditTemplates.save({ description: '', name: 'Credits', source: 'unused' });
	const credited = await repository.createProgram({ name: 'Credited', config: { ...leaf.config, subtitlePreferences: { creditsTemplateId: credit.id } } });
	await expect(repository.updateProgram(sequence.id, { config: { ...sequence.config, entries: sequence.config.entries.map((entry) => ({ ...entry, programId: credited.id })) } })).resolves.toBeTruthy();
});
