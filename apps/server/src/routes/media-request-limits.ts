import { MAX_EXCLUDED_MEDIA_ITEMS, MAX_EXPLICIT_MEDIA_GROUPS, MAX_EXPLICIT_MEDIA_ITEMS } from '@moirai/shared';

/** UTF-8 bytes for a JSON UUID, its quotes, and the following separator. */
const UUID_ENTRY_BYTES = 39;

/** Allow bounded filters, prompts, preferences, and normal JSON formatting around the ID lists. */
const JSON_ENVELOPE_BYTES = 128 * 1024;

/** Budget the item and group lists used by one Content exclusion set. */
const EXCLUSION_BYTES = (MAX_EXCLUDED_MEDIA_ITEMS + MAX_EXPLICIT_MEDIA_GROUPS) * UUID_ENTRY_BYTES;

/** Allow authored items, manual order, insertion batches, and exclusions in one Program save. */
export const PROGRAM_REQUEST_BODY_LIMIT = 3 * MAX_EXPLICIT_MEDIA_ITEMS * UUID_ENTRY_BYTES
	+ 2 * MAX_EXPLICIT_MEDIA_ITEMS + EXCLUSION_BYTES + JSON_ENVELOPE_BYTES;

/** Allow the selected items alongside one exclusion set in a catalog lookup. */
export const MEDIA_SELECTION_BODY_LIMIT = MAX_EXPLICIT_MEDIA_ITEMS * UUID_ENTRY_BYTES
	+ EXCLUSION_BYTES + JSON_ENVELOPE_BYTES;

/** Allow both the legacy item-only list and the current exclusion set in an AI request. */
export const AI_SELECTION_BODY_LIMIT = MAX_EXCLUDED_MEDIA_ITEMS * UUID_ENTRY_BYTES
	+ EXCLUSION_BYTES + JSON_ENVELOPE_BYTES;

/** Allow a complete exclusion set alongside the authored filters in a query preview. */
export const QUERY_PREVIEW_BODY_LIMIT = EXCLUSION_BYTES + JSON_ENVELOPE_BYTES;
