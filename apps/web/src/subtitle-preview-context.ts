import type { SchedulingProgram } from '@moirai/shared';

/** Coalesce rapid subtitle preview search and preference edits before requesting metadata. */
export const SUBTITLE_PREVIEW_UPDATE_DELAY_MS = 300;

/** Offer direct containing sequences without enumerating every possible ancestry path. */
export function subtitlePreviewParents(programs: SchedulingProgram[], targetId: string | null | undefined, chain: string[]): SchedulingProgram[] {
	const child = chain[0] ?? targetId;
	if (!child) {
		return [];
	}
	return programs.filter(program => program.config.type === 'sequence' && program.id !== targetId
		&& !chain.includes(program.id) && program.config.entries.some(entry => entry.programId === child));
}

/** Validate an explicitly chosen outer-to-inner chain against the loaded saved graph. */
export function validSubtitlePreviewChain(programs: SchedulingProgram[], targetId: string | null | undefined, chain: string[]): boolean {
	if (new Set(chain).size !== chain.length || (targetId && chain.includes(targetId))) {
		return false;
	}
	return chain.every((id, index) => {
		const program = programs.find(program => program.id === id);
		const child = chain[index + 1] ?? targetId;
		return program?.config.type === 'sequence' && program.config.entries.some(entry => entry.programId === child);
	});
}
