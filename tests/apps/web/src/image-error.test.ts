import { describe, expect, it } from 'vitest';
import { hideBrokenImage } from '@web/image-error';

describe('broken images', () => {
	it('hides the image that emitted the error', () => {
		const image = { hidden: false };
		const event = { currentTarget: image } as unknown as Event;

		hideBrokenImage(event);

		expect(image.hidden).toBe(true);
	});
});
