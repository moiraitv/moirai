import type { MediaSourcePickerResult, ProgramContentBrowseRequest, SchedulableMedia, SchedulingCatalog, SchedulingProgram } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { currentTimestamp } from '../time.js';
import { orderedLibraryQueryMatches } from './content-query.js';
import { indexedContentMatches, orderContentMatches, withoutContentExclusions } from './content-source.js';

/** One unique immediate child of the requested hierarchy level. */
interface ContentChild {
	id: string;
	kind: 'item' | 'group';
}

/** Project ordered membership into a hierarchy, retaining each child's first occurrence. */
function contentChildren(matches: SchedulableMedia[], catalog: SchedulingCatalog, parentId?: string): ContentChild[] {
	const children = new Map<string, ContentChild>();
	for (const media of matches) {
		let child: ContentChild = { id: media.id, kind: 'item' };
		let parent = media.groupId;
		const visited = new Set<string>();
		while (parent && parent !== parentId && !visited.has(parent)) {
			visited.add(parent);
			child = { id: parent, kind: 'group' };
			parent = catalog.groupParents[parent] ?? null;
		}
		if ((parent ?? undefined) === parentId) {
			children.set(`${child.kind}-${child.id}`, child);
		}
	}
	return [...children.values()];
}

/** Resolve live draft membership and hydrate only the requested page in the read worker. */
export async function browseProgramContent(repository: Repository, input: ProgramContentBrowseRequest): Promise<MediaSourcePickerResult> {
	const { source, parentId, pageSize } = input;
	if (!await repository.getLibrary(source.libraryId)) {
		throw Object.assign(new Error('Library not found'), { statusCode: 404, expose: true });
	}

	// Reuse scheduling's scoped catalog, identity resolution, and membership rules.
	const timestamp = currentTimestamp();
	const draft: SchedulingProgram = { id: '00000000-0000-4000-8000-000000000003', name: 'Current content',
		config: { type: 'content', source, strategy: { type: 'sequential' } }, createdAt: timestamp, updatedAt: timestamp };
	const catalog = await repository.getSchedulingCatalog([draft]);
	const eligible = withoutContentExclusions(indexedContentMatches(source, catalog), source, catalog);
	const ordered = source.type === 'library-query' ? orderedLibraryQueryMatches(eligible, source) : orderContentMatches(eligible, source, catalog);
	const matches = [...new Map(ordered.map(media => [media.id, media])).values()];
	const children = contentChildren(matches, catalog, parentId);
	const totalPages = Math.max(1, Math.ceil(children.length / pageSize));
	const page = Math.min(input.page, totalPages);
	const selected = children.slice((page - 1) * pageSize, page * pageSize);

	// Metadata reads are batched and bounded by the displayed page.
	const [groups, items] = await Promise.all([
		repository.listMediaGroupsByIds(source.libraryId, selected.filter(child => child.kind === 'group').map(child => child.id)),
		repository.listMediaItemsByIds(source.libraryId, selected.filter(child => child.kind === 'item').map(child => child.id)),
	]);
	const groupsById = new Map(groups.map(group => [group.id, group]));
	const itemsById = new Map(items.map(item => [item.id, item]));
	return {
		entries: selected.map(child => ({ key: child.id, kind: child.kind, navigationKey: child.id,
			sectionKey: null, sectionLabel: null, matches: [],
			parentTitle: parentId ? catalog.groupTitles[parentId] : undefined,
			group: groupsById.get(child.id) ?? null, item: itemsById.get(child.id) ?? null })),
		pagination: { page, pageSize, totalEntries: children.length, totalPages },
	};
}
