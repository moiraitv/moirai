import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaCardPreview } from '@moirai/shared';
import {
	clearMediaCardPreviewCache,
	loadMediaCardPreview,
	mediaCardPreviewPosition,
} from '@web/media-card-preview.js';

/** Create one complete bounded preview for cache behavior tests. */
function preview(id: string): MediaCardPreview {
	return {
		id,
		title: 'Preview',
		year: 2026,
		plot: 'Summary',
		artworkUrl: null,
		rating: 8,
		primaryGenre: 'Drama',
		actors: ['Actor'],
	};
}

beforeEach(() => clearMediaCardPreviewCache());

describe('media card previews', () => {
	it('deduplicates concurrent requests and retains successful results', async () => {
		const loader = vi.fn(async (id: string) => preview(id));
		const first = loadMediaCardPreview('item-1', loader);
		const second = loadMediaCardPreview('item-1', loader);

		expect(first).toBe(second);
		expect(await first).toEqual(preview('item-1'));
		expect(await loadMediaCardPreview('item-1', loader)).toEqual(preview('item-1'));
		expect(loader).toHaveBeenCalledOnce();
	});

	it('does not retain a failed request', async () => {
		const loader = vi.fn()
			.mockRejectedValueOnce(new Error('Unavailable'))
			.mockResolvedValueOnce(preview('item-1'));

		await expect(loadMediaCardPreview('item-1', loader)).rejects.toThrow('Unavailable');
		await expect(loadMediaCardPreview('item-1', loader)).resolves.toEqual(preview('item-1'));
		expect(loader).toHaveBeenCalledTimes(2);
	});

	it('does not restore prior-session data when an in-flight request completes', async () => {
		let resolveRequest: ((value: MediaCardPreview) => void) | undefined;
		const firstLoader = vi.fn(() => new Promise<MediaCardPreview>((resolve) => {
			resolveRequest = resolve;
		}));
		const first = loadMediaCardPreview('item-1', firstLoader);

		clearMediaCardPreviewCache();
		resolveRequest?.(preview('item-1'));
		await first;

		const secondLoader = vi.fn(async (id: string) => preview(id));
		await loadMediaCardPreview('item-1', secondLoader);
		expect(secondLoader).toHaveBeenCalledOnce();
	});

	it('uses the right side when it fits and flips to the left near the edge', () => {
		expect(mediaCardPreviewPosition({
			anchor: { top: 100, right: 200, bottom: 200, left: 100, height: 100 },
			previewWidth: 300,
			previewHeight: 180,
			viewportWidth: 900,
			viewportHeight: 700,
		})).toEqual({ left: 212, top: 60 });
		expect(mediaCardPreviewPosition({
			anchor: { top: 650, right: 850, bottom: 700, left: 750, height: 50 },
			previewWidth: 300,
			previewHeight: 180,
			viewportWidth: 900,
			viewportHeight: 700,
		})).toEqual({ left: 438, top: 508 });
	});

	it('clamps oversized edge placement inside the viewport margin', () => {
		expect(mediaCardPreviewPosition({
			anchor: { top: -30, right: 35, bottom: 20, left: -20, height: 50 },
			previewWidth: 360,
			previewHeight: 500,
			viewportWidth: 375,
			viewportHeight: 600,
		})).toEqual({ left: 12, top: 12 });
	});
});
