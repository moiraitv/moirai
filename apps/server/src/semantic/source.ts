import { mediaMatchesLibraryQuery } from '../scheduling/content-query.js';
import type { ProgramConfig, SchedulingCatalog, SchedulingProgram } from '@moirai/shared';

/** Resolve semantic source scope consistently for previews, retries, and seed generation. */
export function semanticSource(config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>, programs: SchedulingProgram[], catalog: SchedulingCatalog) {
	const source = config.type === 'similarity' ? programs.find((program) => program.id === config.sourceProgramId) : undefined;
	const collection = source?.config.type === 'content' && source.config.source.type === 'collection' ? source.config.source : null;
	const libraryId = config.type === 'theme' ? config.libraryId : collection?.libraryId;
	const valid = config.type === 'theme' ? Boolean(catalog.libraryAvailability[config.libraryId]) : Boolean(collection);
	const sourceIds = [...new Set(collection?.itemIds.map((id) => catalog.mediaAliases?.[id] ?? id) ?? [])];
	const ids = new Set(sourceIds);
	const kinds = new Set(catalog.media.filter((media) => ids.has(media.id)).map((media) => media.kind));
	const query = libraryId && config.filter
		? { ...config.filter, type: 'library-query' as const, libraryId, kinds: [] } : null;
	const items = catalog.media.filter((media) => media.libraryId === libraryId
		&& (config.type === 'theme' || kinds.has(media.kind)) && !ids.has(media.id)
		&& (!query || mediaMatchesLibraryQuery(media, query)));
	const anchors = semanticAnchors(config, sourceIds, catalog);
	return { valid, sourceIds, items, anchors,
		label: config.type === 'theme' ? `Theme: ${config.theme}` : `Similar to ${source?.name}`,
		missing: config.type === 'theme' ? 'Missing target library' : 'Missing Specific media items source' };
}

/** Use the theme vector or source-media vectors as the primary relevance anchors. */
export function semanticAnchors(config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>, sourceIds: string[], catalog: SchedulingCatalog): number[][] {
	if (config.type === 'theme') {
		const theme = catalog.semantic?.preferences?.[config.theme]?.vector;
		return theme ? [theme] : [];
	}
	return sourceIds.flatMap((id) => catalog.semantic?.vectors[id] ? [catalog.semantic.vectors[id]!] : []);
}
