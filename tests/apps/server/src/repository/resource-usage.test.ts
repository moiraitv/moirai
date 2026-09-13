import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@server/db/index.js';
import { resourceUsage } from '@server/repository/resource-usage.js';

const databases: ReturnType<typeof createDatabase>[] = [];
function fixture() {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	const insert = (table: string, columns: Record<string, unknown>) => {
		const values = ['schedule_slots', 'channel_schedule_layers'].includes(table) ? columns : { ...columns, created_at: '2026-01-01', updated_at: '2026-01-01' };
		database.db.run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(Object.keys(values).map(key => sql.identifier(key)), sql`, `)}) VALUES (${sql.join(Object.values(values).map(value => sql`${typeof value === 'object' ? JSON.stringify(value) : value}`), sql`, `)})`);
	};
	return { ...database, insert };
}
afterEach(() => {
	for (const db of databases.splice(0)) {
		db.close(); 
	} 
});

it('groups every program reference role without expanding indirect channels and keeps query count fixed', () => {
	const { db, insert, sqlite } = fixture();
	const id = randomUUID(), parent = randomUUID(), template = randomUUID(), channel = randomUUID();
	insert('scheduling_programs', { id, name: 'Target', config: { type: 'content' } });
	insert('scheduling_programs', { id: parent, name: 'Parent', config: { type: 'sequence', entries: [{ programId: id }, { programId: id }] } });
	insert('schedule_templates', { id: template, name: 'Template', default_filler: { programId: id } });
	insert('schedule_slots', { id: randomUUID(), template_id: template, position: 0, start_seconds: 0, program_id: id, state_scope: 'shared', start_eligibility: {}, filler: { mode: 'configured', config: { programId: id } } });
	insert('channels', { id: channel, number: '1', name: 'Channel', config: {} });
	insert('channel_schedules', { channel_id: channel, default_template_id: template, config: { defaultFiller: { programId: id } } });
	const prepare = vi.spyOn(sqlite, 'prepare');
	const result = resourceUsage(db, 'program', id, 1, 50)!;
	expect(result.total).toBe(3);
	expect(result.items.find(row => row.id === template)).toMatchObject({ referenceCount: 3, roles: ['Default filler', 'Slot filler', 'Slot program'] });
	expect(result.items.find(row => row.id === parent)?.referenceCount).toBe(2);
	expect(result.items.find(row => row.id === channel)?.kind).toBe('channel-schedule');
	expect(prepare.mock.calls.filter(([query]) => /SELECT/i.test(query))).toHaveLength(3);
	prepare.mockRestore();
	expect(resourceUsage(db, 'program', randomUUID(), 1, 50)).toBeNull();
});

it('paginates owners deterministically and includes both template assignment roles', () => {
	const { db, insert } = fixture();
	const template = randomUUID();
	insert('schedule_templates', { id: template, name: 'Target' });
	for (let index = 0; index < 53; index++) {
		const id = randomUUID();
		insert('channels', { id, number: String(index), name: `Channel ${String(index).padStart(2, '0')}`, config: {} });
		insert('channel_schedules', { channel_id: id, default_template_id: template, config: {} });
		insert('channel_schedule_layers', { id: randomUUID(), channel_id: id, position: 0, template_id: template, predicate: {}, entry_boundary: {}, exit_boundary: {} });
	}
	const first = resourceUsage(db, 'template', template, 1, 50)!;
	const last = resourceUsage(db, 'template', template, 2, 50)!;
	expect(first.total).toBe(53);
	expect(first.items).toHaveLength(50);
	expect(last.items).toHaveLength(3);
	expect(last.items[0]).toMatchObject({ name: 'Channel 50', roles: ['Base template', 'Conditional template'], referenceCount: 2 });
	expect(resourceUsage(db, 'template', template, 3, 50)?.items).toEqual([]);
});

it('counts explicit encoding and credit references, including disabled authored credit assignments', () => {
	const { db, insert } = fixture();
	const encoding = randomUUID(), credit = randomUUID(), channel = randomUUID(), program = randomUUID();
	insert('encoding_profiles', { id: encoding, name: 'Profile', name_key: 'profile', config: {} });
	insert('credit_templates', { id: credit, name: 'Credit', name_key: 'credit', source: 'test' });
	const subtitlePreferences = { creditsTemplateId: credit, selection: 'off' };
	insert('channels', { id: channel, number: '1', name: 'Channel', config: { encodingProfileId: encoding, subtitlePreferences } });
	insert('scheduling_programs', { id: program, name: 'Program', config: { type: 'sequence', entries: [], subtitlePreferences } });
	expect(resourceUsage(db, 'encoding-profile', encoding, 1, 50)).toMatchObject({ total: 1, items: [{ id: channel }] });
	expect(resourceUsage(db, 'credit-template', credit, 1, 50)?.items.map(item => item.id).sort()).toEqual([channel, program].sort());
});
