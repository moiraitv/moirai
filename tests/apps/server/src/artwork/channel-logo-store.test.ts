import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { validateChannelLogo } from '@server/artwork/channel-logo-store.js';

describe('channel logo validation', () => {
	it('preserves fully transparent and partially transparent pixel alpha values', async () => {
		const rgba = Buffer.from([200, 100, 50, 0, 200, 100, 50, 128, 200, 100, 50, 255]);
		const png = await sharp(rgba, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
		const validated = await validateChannelLogo(png);
		const pixels = await sharp(validated.content).ensureAlpha().raw().toBuffer();
		expect([pixels[3], pixels[7], pixels[11]]).toEqual([0, 128, 255]);
	});

	it('fully decodes and preserves PNG dimensions and transparency', async () => {
		const png = await sharp({
			create: { width: 640, height: 360, channels: 4, background: '#00000000' },
		}).png().toBuffer();
		const validated = await validateChannelLogo(png);
		expect(validated).toMatchObject({ width: 640, height: 360 });
		expect((await sharp(validated.content).metadata()).hasAlpha).toBe(true);
	});

	it('rejects non-PNG input', async () => {
		await expect(validateChannelLogo(Buffer.from('not an image'))).rejects.toThrow(/PNG/);
	});

	it('rejects a plausible PNG header whose image data cannot be decoded', async () => {
		const png = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(13, 8);
		png.write('IHDR', 12, 'ascii');
		png.writeUInt32BE(640, 16);
		png.writeUInt32BE(360, 20);
		await expect(validateChannelLogo(png)).rejects.toThrow(/PNG/);
	});
});
