import { z } from 'zod';
import { MAX_EXPLICIT_MEDIA_GROUPS, MAX_EXPLICIT_MEDIA_ITEMS } from './media-limits.js';

/** Maximum individually removed items retained by one program. */
export const MAX_EXCLUDED_MEDIA_ITEMS = MAX_EXPLICIT_MEDIA_ITEMS;

/** Canonical set of media identities removed until explicitly restored. */
export const excludedItemIdsSchema = z.array(z.uuid()).max(MAX_EXCLUDED_MEDIA_ITEMS)
	.transform((ids) => [...new Set(ids)].sort());

/** Bound and canonicalize item and group exclusions independently of their inclusion source. */
export const contentExclusionsSchema = z.object({
	itemIds: excludedItemIdsSchema.default([]),
	groupIds: z.array(z.uuid()).max(MAX_EXPLICIT_MEDIA_GROUPS)
		.transform(ids => [...new Set(ids)].sort()).default([]),
});
/** Individually excluded media and group roots whose descendants are also excluded. */
export type ContentExclusions = z.infer<typeof contentExclusionsSchema>;

/** Combine the current set with item-only exclusions from older AI programs and clients. */
export function mergeContentExclusions(exclusions: ContentExclusions | undefined, legacyItems?: string[]): ContentExclusions | undefined {
	return legacyItems?.length ? {
		itemIds: [...new Set([...exclusions?.itemIds ?? [], ...legacyItems])].sort(),
		groupIds: exclusions?.groupIds ?? [],
	} : exclusions;
}

/** Accepted item exclusions in the original and current AI wire formats. */
interface AiExclusionFields {
	excludedItemIds?: string[] | undefined;
	exclusions?: ContentExclusions | undefined;
}

/** Cap distinct item exclusions across both AI request representations. */
export function validateAiExclusionLimit(source: AiExclusionFields, context: z.RefinementCtx): void {
	if (source.excludedItemIds?.length && source.exclusions?.itemIds.length
		&& new Set([...source.excludedItemIds, ...source.exclusions.itemIds]).size > MAX_EXCLUDED_MEDIA_ITEMS) {
		context.addIssue({ code: 'custom', path: ['exclusions', 'itemIds'], message: 'Too many excluded items' });
	}
}

/** Preserve the legacy frozen-removal invariant and cap the combined item exclusion set. */
export function validateAiSourceExclusions(source: AiExclusionFields & { itemIds: string[] }, context: z.RefinementCtx): void {
	const legacy = new Set(source.excludedItemIds);
	if (source.itemIds.some(id => legacy.has(id))) {
		context.addIssue({ code: 'custom', path: ['itemIds'], message: 'Selected items cannot also be removed' });
	}
	validateAiExclusionLimit(source, context);
}
