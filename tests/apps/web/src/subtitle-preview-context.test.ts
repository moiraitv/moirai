import { describe, expect, it } from 'vitest';
import type { SchedulingProgram } from '@moirai/shared';
import { subtitlePreviewParents, validSubtitlePreviewChain } from '@web/subtitle-preview-context';

function sequence(id: string, children: string[]): SchedulingProgram {
	return { id, config: { type: 'sequence', entries: children.map(programId => ({ programId })) } } as SchedulingProgram;
}

describe('explicit subtitle preview contexts', () => {
	const programs = [sequence('outer', ['cycle', 'inner']), sequence('inner', ['leaf']), sequence('other', ['leaf']), sequence('cycle', ['outer'])];
	it('offers only direct parents and constructs outer-to-inner ancestry incrementally', () => {
		expect(subtitlePreviewParents(programs, 'leaf', []).map(program => program.id)).toEqual(['inner', 'other']);
		expect(subtitlePreviewParents(programs, 'leaf', ['inner']).map(program => program.id)).toEqual(['outer']);
		expect(validSubtitlePreviewChain(programs, 'leaf', ['outer', 'inner'])).toBe(true);
		expect(validSubtitlePreviewChain(programs, 'leaf', [])).toBe(true);
	});
	it('rejects repeated, missing, unrelated, and self-containing ancestors', () => {
		expect(validSubtitlePreviewChain(programs, 'leaf', ['outer', 'outer', 'inner'])).toBe(false);
		expect(validSubtitlePreviewChain(programs, 'leaf', ['missing'])).toBe(false);
		expect(validSubtitlePreviewChain(programs, 'leaf', ['outer'])).toBe(false);
		expect(validSubtitlePreviewChain(programs, 'leaf', ['leaf'])).toBe(false);
		expect(subtitlePreviewParents(programs, 'leaf', ['cycle', 'outer', 'inner'])).toEqual([]);
		expect(subtitlePreviewParents(programs, null, [])).toEqual([]);
	});
});
