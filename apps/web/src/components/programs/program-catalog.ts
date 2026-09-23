import type { SchedulingProgram, SchedulingProgramStatus } from '@moirai/shared';
import { orderCatalogNames } from '../../catalog-name-order';

/** Presentation metadata shared by the toolbar and inspector registry. */
export const programTypes = {
	content: 'Content', similarity: 'Similar Items', theme: 'Theme', sequence: 'Sequence',
};
/** Resolve a label without hiding future program types. */
export function programTypeLabel(type: string): string {
	return programTypes[type as keyof typeof programTypes] ?? type;
}
/** Group legacy single selections with their modern collection equivalents. */
export function contentSubtype(program: SchedulingProgram): string {
	if (program.config.type !== 'content') {
		return '';
	}
	const type = program.config.source.type;
	return type === 'library-query' ? 'query' : ['group', 'group-collection'].includes(type) ? 'groups' : 'items';
}
/** User-facing Content definitions shared by filtering and details. */
export const contentSubtypeLabels: Record<string, string> = {
	query: 'Library Query', items: 'Specific Items', groups: 'Specific Groups',
};
/** Describe a saved definition without fetching media or computing generated sets. */
export function programDefinition(program: SchedulingProgram, programs: Map<string, SchedulingProgram>): string {
	const config = program.config;
	switch (config.type) {
		case 'content': return contentSubtypeLabels[contentSubtype(program)] ?? 'Content';
		case 'similarity': return `Based on “${programs.get(config.sourceProgramId)?.name ?? 'Missing Program'}”`;
		case 'theme': return `Prompt-based · ${config.theme}`;
		case 'sequence': return `${config.entries.length} source Programs`;
		default: return 'Program definition';
	}
}
/** URL-backed catalog controls; unknown values fall back to the unfiltered default. */
export interface ProgramCatalogFilters {
	q: string; type: string; subtype: string; usage: string; sort: string;
}
/** Filter and order the already-loaded overview without per-row requests. */
export function filterPrograms(programs: SchedulingProgram[], statuses: Map<string, SchedulingProgramStatus>, usages: Map<string, number>, filters: ProgramCatalogFilters): SchedulingProgram[] {
	const byId = new Map(programs.map(program => [program.id, program]));
	const search = filters.q.trim().toLocaleLowerCase();
	const result = orderCatalogNames(programs.filter(program => {
		if (filters.type in programTypes && program.config.type !== filters.type) {
			return false;
		}
		if (filters.subtype in contentSubtypeLabels && contentSubtype(program) !== filters.subtype) {
			return false;
		}
		const used = (usages.get(program.id) ?? 0) > 0;
		if ((filters.usage === 'used' && !used) || (filters.usage === 'unused' && used)) {
			return false;
		}
		return !search || `${program.name} ${programTypeLabel(program.config.type)} ${programDefinition(program, byId)} ${statuses.get(program.id)?.sourceLabel ?? ''}`.toLocaleLowerCase().includes(search);
	}));
	if (filters.sort === 'name-desc') {
		return result.reverse();
	}
	if (filters.sort === 'updated') {
		result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}
	if (filters.sort === 'usage') {
		result.sort((a, b) => (usages.get(b.id) ?? 0) - (usages.get(a.id) ?? 0));
	}
	return result;
}

/** Present stored enum values as readable title-cased labels. */
export function programValueLabel(value: string): string {
	return value.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/** Describe unavailable indexed items without reporting absence during preview preparation. */
export function programUnavailableTooltip(status?: SchedulingProgramStatus): string | undefined {
	if (!status || status.previewPending) {
		return undefined;
	}
	const unavailable = status.indexedItemCount - status.availableItemCount;
	return unavailable > 0 ? `${unavailable} unavailable` : undefined;
}
