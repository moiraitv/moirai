import { mergeProgramMetadata, type ProgramMetadata, type ProgramTemplateContext, type TimelineSegment } from '@moirai/shared';

/** The committed fields needed to identify a clip's Program selection path. */
type ProgramSelection = Pick<TimelineSegment, 'programId' | 'programAncestry' | 'role'>;

/** Return the committed ancestry, using the recorded Program alone for legacy segments. */
export function metadataProgramIds(selection?: ProgramSelection): readonly string[] {
	if (!selection || selection.role === 'dead-air') {
		return [];
	}
	return selection.programAncestry?.length ? selection.programAncestry : selection.programId ? [selection.programId] : [];
}

/** Merge current Program fields along a committed path, retaining child overrides including blanks. */
export function resolveProgramMetadata(
	selection?: ProgramSelection,
	byId?: ReadonlyMap<string, ProgramMetadata>,
): ProgramTemplateContext {
	return { metadata: mergeProgramMetadata(metadataProgramIds(selection).map(id => byId?.get(id))) };
}
