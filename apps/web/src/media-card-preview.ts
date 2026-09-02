import type { MediaCardPreview } from '@moirai/shared';
import { api } from './api';
import { viewportTooltipPosition } from './viewport-tooltip';

/** Successful card previews retained for the lifetime of the current application session. */
const previewCache = new Map<string, MediaCardPreview>();
/** In-flight preview requests shared by every card representing the same media item. */
const previewRequests = new Map<string, Promise<MediaCardPreview>>();
/** Authentication generation that prevents a completed prior-session request from restoring cache data. */
let previewSessionGeneration = 0;

/** Screen geometry needed to place one fixed media-card tooltip. */
export interface MediaCardPreviewGeometry {
	anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'height'>;
	previewWidth: number;
	previewHeight: number;
	viewportWidth: number;
	viewportHeight: number;
}

/** Fixed viewport coordinates for one media-card tooltip. */
export interface MediaCardPreviewPosition {
	left: number;
	top: number;
}

/** Load and cache one bounded preview while deduplicating overlapping card requests. */
export function loadMediaCardPreview(
	id: string,
	loader: (mediaId: string) => Promise<MediaCardPreview> = api.mediaCardPreview,
): Promise<MediaCardPreview> {
	const cached = previewCache.get(id);
	if (cached) {
		return Promise.resolve(cached);
	}

	const pending = previewRequests.get(id);
	if (pending) {
		return pending;
	}

	const requestGeneration = previewSessionGeneration;
	const request = loader(id)
		.then((preview) => {
			if (requestGeneration === previewSessionGeneration) {
				previewCache.set(id, preview);
			}
			return preview;
		})
		.finally(() => previewRequests.delete(id));
	previewRequests.set(id, request);
	return request;
}

/** Clear session preview state for authentication changes and focused tests. */
export function clearMediaCardPreviewCache(): void {
	previewSessionGeneration += 1;
	previewCache.clear();
	previewRequests.clear();
}

/** Place a tooltip beside its card, flip horizontally, and clamp it inside the viewport. */
export function mediaCardPreviewPosition(
	geometry: MediaCardPreviewGeometry,
): MediaCardPreviewPosition {
	const { anchor, previewWidth, previewHeight, viewportWidth, viewportHeight } = geometry;
	return viewportTooltipPosition({
		anchor,
		tooltipWidth: previewWidth,
		tooltipHeight: previewHeight,
		viewportWidth,
		viewportHeight,
	});
}
