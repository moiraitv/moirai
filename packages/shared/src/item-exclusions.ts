import { z } from 'zod';
import { MAX_EXPLICIT_MEDIA_ITEMS } from './media-limits.js';

/** Maximum individually removed items retained by one program. */
export const MAX_EXCLUDED_MEDIA_ITEMS = MAX_EXPLICIT_MEDIA_ITEMS;

/** Canonical set of media identities removed until explicitly restored. */
export const excludedItemIdsSchema = z.array(z.uuid()).max(MAX_EXCLUDED_MEDIA_ITEMS)
	.transform((ids) => [...new Set(ids)].sort());
