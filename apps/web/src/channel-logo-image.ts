const SOURCE_MAX_BYTES = 25 * 1024 * 1024;
const SOURCE_MAX_PIXELS = 64_000_000;

/** Loaded local image with a temporary URL owned by its caller. */
export interface LoadedChannelLogoImage {
	url: string;
	image: HTMLImageElement;
	width: number;
	height: number;
}

/** Source image region rendered into a prepared channel logo. */
export interface ChannelLogoRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Prepared PNG and local preview owned by a Quick Setup draft. */
export interface PreparedChannelLogo {
	blob: Blob;
	previewUrl: string;
}

/** Validate and decode one local image while transferring temporary-URL ownership to the caller. */
export async function loadChannelLogoImage(file: File): Promise<LoadedChannelLogoImage> {
	if (file.size > SOURCE_MAX_BYTES) {
		throw new Error('Choose an image smaller than 25 MiB.');
	}

	const url = URL.createObjectURL(file);
	const image = new Image();
	try {
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('The selected file is not a supported image.'));
			image.src = url;
		});
		if (image.naturalWidth * image.naturalHeight > SOURCE_MAX_PIXELS) {
			throw new Error('Choose an image with no more than 64 megapixels.');
		}

		return {
			url,
			image,
			width: image.naturalWidth,
			height: image.naturalHeight,
		};
	}
	catch (cause) {
		URL.revokeObjectURL(url);
		throw cause;
	}
}

/** Render an image region to a bounded PNG without upscaling or changing its aspect ratio. */
export async function renderChannelLogoPng(
	image: HTMLImageElement,
	region: ChannelLogoRegion,
	maximumWidth: number,
	maximumHeight: number,
	maximumBytes: number,
): Promise<Blob> {
	let scale = Math.min(1, maximumWidth / region.width, maximumHeight / region.height);
	let width = Math.max(1, Math.floor(region.width * scale));
	let height = Math.max(1, Math.floor(region.height * scale));
	const canvas = document.createElement('canvas');
	const encode = async (): Promise<Blob> => {
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('This browser cannot prepare the channel logo.');
		}
		context.drawImage(
			image,
			region.x,
			region.y,
			region.width,
			region.height,
			0,
			0,
			width,
			height,
		);
		return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
			if (blob) {
				resolve(blob);
			}
			else {
				reject(new Error('The browser could not encode the channel logo.'));
			}
		}, 'image/png'));
	};

	let blob = await encode();
	while (blob.size > maximumBytes && (width > 1 || height > 1)) {
		scale = Math.sqrt(maximumBytes / blob.size) * 0.9;
		width = Math.max(1, Math.min(width - 1, Math.floor(width * scale)));
		height = Math.max(1, Math.min(height - 1, Math.floor(height * scale)));
		blob = await encode();
	}
	return blob;
}

/** Load an image file and convert its full uncropped contents to a bounded PNG. */
export async function prepareChannelLogo(
	file: File,
	maximumWidth: number,
	maximumHeight: number,
	maximumBytes: number,
): Promise<PreparedChannelLogo> {
	const source = await loadChannelLogoImage(file);
	try {
		const blob = await renderChannelLogoPng(
			source.image,
			{ x: 0, y: 0, width: source.width, height: source.height },
			maximumWidth,
			maximumHeight,
			maximumBytes,
		);
		return { blob, previewUrl: URL.createObjectURL(blob) };
	}
	finally {
		URL.revokeObjectURL(source.url);
	}
}
