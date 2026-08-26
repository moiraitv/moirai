import path from 'node:path';

/** Common browser-safe raster formats accepted for indexed library artwork. */
export const ARTWORK_EXTENSIONS = [
	'.avif',
	'.bmp',
	'.gif',
	'.jpe',
	'.jfif',
	'.jpeg',
	'.jpg',
	'.png',
	'.tif',
	'.tiff',
	'.webp',
] as const;

/** Case-normalized lookup set used to validate indexed artwork suffixes. */
const ARTWORK_EXTENSION_SET = new Set<string>(ARTWORK_EXTENSIONS);

/** Return the safe response media type for an artwork filename. */
export function artworkMimeType(file: string): string {
	const extension = path.extname(file).toLowerCase();
	return (
		new Map([
			['.avif', 'image/avif'],
			['.bmp', 'image/bmp'],
			['.gif', 'image/gif'],
			['.png', 'image/png'],
			['.tif', 'image/tiff'],
			['.tiff', 'image/tiff'],
			['.webp', 'image/webp'],
		]).get(extension) ?? 'image/jpeg'
	);
}

/** Keep a recognized source suffix on cache files so responses get the correct media type. */
export function normalizedArtworkExtension(file: string): string {
	const extension = path.extname(file).toLowerCase();
	return ARTWORK_EXTENSION_SET.has(extension) ? extension : '.jpg';
}
