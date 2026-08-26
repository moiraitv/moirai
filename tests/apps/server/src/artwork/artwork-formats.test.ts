import { describe, expect, it } from 'vitest';
import {
	ARTWORK_EXTENSIONS,
	artworkMimeType,
	normalizedArtworkExtension,
} from '@server/artwork/artwork-formats.js';

describe('artwork formats', () => {
	it.each(ARTWORK_EXTENSIONS)('preserves the supported %s suffix', (extension) => {
		expect(normalizedArtworkExtension(`poster${extension}`)).toBe(extension);
	});

	it('maps representative non-JPEG formats to their response media types', () => {
		expect(artworkMimeType('poster.png')).toBe('image/png');
		expect(artworkMimeType('poster.webp')).toBe('image/webp');
		expect(artworkMimeType('poster.avif')).toBe('image/avif');
	});
});
