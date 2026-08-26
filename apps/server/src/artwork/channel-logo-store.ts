import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { CHANNEL_LOGO_MAX_BYTES, CHANNEL_LOGO_MAX_DIMENSION, type Channel } from '@moirai/shared';

/** Pixel dimensions detected from an uploaded channel logo. */
export interface ChannelLogoDimensions {
	width: number;
	height: number;
}

/** Fully decoded and normalized channel-logo payload. */
interface ValidatedChannelLogo extends ChannelLogoDimensions {
	content: Buffer;
}

/** Report a managed logo that fails size, format, or dimension validation. */
export class ChannelLogoValidationError extends Error {}

/** Fully decode and normalize a PNG so malformed image data cannot reach managed storage. */
export async function validateChannelLogo(content: Buffer): Promise<ValidatedChannelLogo> {
	try {
		const inputOptions = {
			failOn: 'error' as const,
			limitInputPixels: CHANNEL_LOGO_MAX_DIMENSION * CHANNEL_LOGO_MAX_DIMENSION,
			pages: 1,
		};
		const metadata = await sharp(content, inputOptions).metadata();
		if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
			throw new ChannelLogoValidationError('Channel logos must be valid PNG images');
		}

		const normalized = await sharp(content, inputOptions).png().toBuffer();
		return { content: normalized, width: metadata.width, height: metadata.height };
	}
	catch (error) {
		if (error instanceof ChannelLogoValidationError) {
			throw error;
		}

		throw new ChannelLogoValidationError('Channel logos must be valid PNG images');
	}
}

/**
 * Own persistent channel-logo files outside the media index. The store fully decodes and normalizes
 * PNG input, enforces channel-specific size limits, and atomically replaces or removes managed files.
 */
export class ChannelLogoStore {
	constructor(private readonly root: string) {}

	/** Resolve the managed PNG path for a validated channel identifier. */
	pathFor(channelId: string): string {
		return path.join(this.root, `${channelId}.png`);
	}

	/** Open a managed logo for streaming without exposing its filesystem path. */
	createReadStream(channelId: string) {
		return createReadStream(this.pathFor(channelId));
	}

	/** Check whether the requested managed asset exists. */
	async exists(channelId: string): Promise<boolean> {
		try {
			return (await stat(this.pathFor(channelId))).isFile();
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return false;
			}

			throw error;
		}
	}

	/** Persist one validated asset using an atomic replacement. */
	async store(channel: Channel, content: Buffer): Promise<ChannelLogoDimensions> {
		if (content.length > CHANNEL_LOGO_MAX_BYTES) {
			throw new ChannelLogoValidationError(
				`Channel logos cannot exceed ${CHANNEL_LOGO_MAX_BYTES} bytes`,
			);
		}

		const validated = await validateChannelLogo(content);
		const dimensions = { width: validated.width, height: validated.height };
		const channelWidth = channel.video.width;
		const channelHeight = channel.video.height;
		if (!channelWidth || !channelHeight) {
			throw new ChannelLogoValidationError('Set the channel resolution before uploading a logo');
		}

		const maximumWidth = Math.min(channelWidth, CHANNEL_LOGO_MAX_DIMENSION);
		const maximumHeight = Math.min(channelHeight, CHANNEL_LOGO_MAX_DIMENSION);
		if (dimensions.width > maximumWidth || dimensions.height > maximumHeight) {
			throw new ChannelLogoValidationError(
				`Channel logo dimensions cannot exceed ${maximumWidth}×${maximumHeight} pixels`,
			);
		}

		if (validated.content.length > CHANNEL_LOGO_MAX_BYTES) {
			throw new ChannelLogoValidationError(
				`Normalized channel logos cannot exceed ${CHANNEL_LOGO_MAX_BYTES} bytes`,
			);
		}

		await mkdir(this.root, { recursive: true });
		const destination = this.pathFor(channel.id);
		const temporary = `${destination}.tmp-${randomUUID()}`;
		try {
			await writeFile(temporary, validated.content, { mode: 0o644 });
			await rename(temporary, destination);
		}
		catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
		return dimensions;
	}

	/** Remove a channel's managed logo if it exists. */
	async remove(channelId: string): Promise<void> {
		await unlink(this.pathFor(channelId)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') {
				throw error;
			}
		});
	}
}
