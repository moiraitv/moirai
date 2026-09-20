import { refinementTexts } from './refinement.js';
import type { SchedulingCatalog, SchedulingProgram } from '@moirai/shared';
import { semanticMediaEligible } from './selection.js';

/** Scope semantic recovery inputs to this channel's sources and retained seed decisions. */
export function semanticSchedulingFingerprint(channelId: string, programs: SchedulingProgram[], catalog: SchedulingCatalog) {
	const semantic = catalog.semantic;
	const selected = programs.filter((program) => program.config.type === 'similarity' || program.config.type === 'theme');
	if (!semantic || !selected.length) {
		return undefined;
	}
	const programIds = new Set(selected.map((program) => program.id));
	const sourceIds = new Set(selected.flatMap((program) => program.config.type === 'similarity' ? [program.config.sourceProgramId] : []));
	const libraryIds = new Set(programs.flatMap((program) => sourceIds.has(program.id)
		&& program.config.type === 'content' && program.config.source.type === 'collection' ? [program.config.source.libraryId] : program.config.type === 'theme' ? [program.config.libraryId] : []));
	const ids = new Set(semantic.seeds.filter((seed) => programIds.has(seed.programId)
		&& ['primary', 'filler'].some((role) => seed.consumerKey.startsWith(`${role}:${channelId}:`)))
		.flatMap((seed) => seed.itemIds));
	for (const media of catalog.media) {
		if (libraryIds.has(media.libraryId)) {
			ids.add(media.id);
		}
	}
	const ordered = [...ids].sort();
	const mediaById = catalog.mediaById ?? new Map(catalog.media.map((media) => [media.id, media]));
	return {
		preferences: selected.flatMap((program) => (program.config.type === 'similarity' || program.config.type === 'theme')
			? refinementTexts(program.config).map((text) => [text, semantic.preferences?.[text]?.status ?? 'pending']) : []),
		pending: semantic.pendingItemIds.filter((id) => ids.has(id)).sort(),
		failed: semantic.failedItemIds.filter((id) => ids.has(id)).sort(),
		ready: ordered.filter((id) => semantic.vectors[id]),
		unavailable: ordered.filter((id) => {
			const media = mediaById.get(id);
			return !media || !semanticMediaEligible(media, catalog);
		}),
	};
}
