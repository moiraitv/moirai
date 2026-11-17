import { MediaServerRequestError } from './http.js';
import { MEDIA_LISTING_MAX_BYTES, MEDIA_LISTING_MAX_ITEMS, MEDIA_LISTING_MAX_PAGES } from './limits.js';

/** Bound one listing's pages, decoded bytes, and unique records before catalog persistence. */
export class MediaListingBudget {
	private pages = 0;
	private bytes = 0;
	private items = 0;
	private readonly identifiers = new Set<string>();
	private declaredTotal: number | undefined;

	/** Claim a request before starting optional additional work. */
	nextPage(): void {
		this.pages += 1;
		if (this.pages > MEDIA_LISTING_MAX_PAGES) {
			throw new MediaServerRequestError('Media server listing exceeds the page limit');
		}
	}

	/** Reject a cumulative response budget before retaining the current chunk. */
	consumeBytes(bytes: number): void {
		this.bytes += bytes;
		if (this.bytes > MEDIA_LISTING_MAX_BYTES) {
			throw new MediaServerRequestError('Media server listing exceeds the byte limit');
		}
	}

	/** Require stable bounded totals and distinct identities across every page. */
	acceptPage(identifiers: Array<string | undefined>, total: unknown): void {
		if (total === undefined && this.declaredTotal !== undefined) {
			throw new MediaServerRequestError('Media server stopped reporting its library total during the listing');
		}

		if (total !== undefined) {
			if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > MEDIA_LISTING_MAX_ITEMS) {
				throw new MediaServerRequestError('Media server reported an invalid library total');
			}
			if (this.declaredTotal !== undefined && total !== this.declaredTotal) {
				throw new MediaServerRequestError('Media server changed its library total during the listing');
			}

			this.declaredTotal = total;
		}

		this.items += identifiers.length;
		if (this.items > MEDIA_LISTING_MAX_ITEMS) {
			throw new MediaServerRequestError('Media server listing exceeds the item limit');
		}

		for (const id of identifiers) {
			if (typeof id !== 'string' || !id || this.identifiers.has(id)) {
				throw new MediaServerRequestError('Media server repeated an item or returned an invalid item identifier');
			}

			this.identifiers.add(id);
		}
	}
}
