/** Deadline for provider metadata, credentials, and artwork, including response consumption. */
export const MEDIA_REQUEST_TIMEOUT_MS = 30_000;
/** Maximum decoded JSON bytes consumed by one provider request. */
export const MEDIA_JSON_MAX_BYTES = 8 * 1_024 * 1_024;
/** Maximum decoded JSON bytes retained across one complete remote listing. */
export const MEDIA_LISTING_MAX_BYTES = 128 * 1_024 * 1_024;
/** Maximum records accepted from one remote library. */
export const MEDIA_LISTING_MAX_ITEMS = 100_000;
/** Maximum requests made by one paginated remote listing. */
export const MEDIA_LISTING_MAX_PAGES = 1_000;
/** Maximum waiting provider artwork downloads; active work uses artwork concurrency. */
export const MEDIA_ARTWORK_QUEUE_LIMIT = 32;
