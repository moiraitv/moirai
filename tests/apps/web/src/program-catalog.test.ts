import { describe, expect, it } from 'vitest';
import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { contentSubtype, filterPrograms, programDefinition, programTypeLabel, programUnavailableTooltip } from '../../../../apps/web/src/components/programs/program-catalog';
const programs: SchedulingProgram[] = [
	{ id: 'a', name: 'The Zebra', createdAt: '', updatedAt: '2026-01-01', config: { type: 'content', source: { type: 'item', itemId: 'item' }, strategy: { type: 'sequential' } } },
	{ id: 'b', name: 'An Apple', createdAt: '', updatedAt: '2026-02-01', config: { type: 'content', source: { type: 'group', groupId: 'group', includeDescendants: true }, strategy: { type: 'sequential' } } },
	{ id: 'c', name: 'Related', createdAt: '', updatedAt: '2026-03-01', config: { type: 'similarity', sourceProgramId: 'a', variety: 35, quantity: 20 } },
];
const base = { q: '', type: '', subtype: '', usage: '', sort: '' };
const usages = new Map([['a', 2]]);
describe('Program management catalog', () => {
	it('retains catalog ordering and supports update and reference ordering', () => {
		expect(filterPrograms(programs, new Map(), usages, base).map(p => p.id)).toEqual(['b', 'c', 'a']);
		expect(filterPrograms(programs, new Map(), usages, { ...base, sort: 'updated' }).map(p => p.id)).toEqual(['c', 'b', 'a']);
		expect(filterPrograms(programs, new Map(), usages, { ...base, sort: 'usage' })[0]?.id).toBe('a');
	});
	it('combines search, subtype, type and usage without mutating source data', () => {
		expect(filterPrograms(programs, new Map(), usages, { ...base, type: 'content', usage: 'unused', subtype: 'groups' }).map(p => p.id)).toEqual(['b']);
		expect(filterPrograms(programs, new Map(), usages, { ...base, q: 'Zebra' }).map(p => p.id)).toEqual(['c', 'a']);
		expect(programs.map(p => p.id)).toEqual(['a', 'b', 'c']);
	});
	it('supports legacy Content definitions and missing or future sources', () => {
		expect(contentSubtype(programs[0]!)).toBe('items');
		expect(contentSubtype(programs[1]!)).toBe('groups');
		expect(programDefinition(programs[2]!, new Map())).toContain('Missing Program');
		expect(programTypeLabel('future')).toBe('future');
	});
});

it('only reports unavailable counts for completed previews with a positive deficit', () => {
	const status: SchedulingProgramStatus = { programId: 'a', health: 'ready', sourceLabel: '', indexedItemCount: 10, availableItemCount: 8, previewItems: [] };
	expect(programUnavailableTooltip(status)).toBe('2 unavailable');
	expect(programUnavailableTooltip({ ...status, availableItemCount: 10 })).toBeUndefined();
	expect(programUnavailableTooltip({ ...status, previewPending: true })).toBeUndefined();
	expect(programUnavailableTooltip()).toBeUndefined();
});
