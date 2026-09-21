import { describe, expect, it } from 'vitest';
import { PROGRAM_COLOR_PALETTE, programColor, programColorStyle } from '@web/program-colors';

function hexChannels(value: string): number[] {
	return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function luminance(value: string): number {
	const [red, green, blue] = hexChannels(value).map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(left: string, right: string): number {
	const leftLuminance = luminance(left);
	const rightLuminance = luminance(right);
	return (
		(Math.max(leftLuminance, rightLuminance) + 0.05)
		/ (Math.min(leftLuminance, rightLuminance) + 0.05)
	);
}

function interpolate(left: string, right: string, fraction: number): string {
	return `#${hexChannels(left)
		.map((channel, index) =>
			Math.round(channel * (1 - fraction) + hexChannels(right)[index]! * fraction)
				.toString(16)
				.padStart(2, '0'))
		.join('')}`;
}

describe('program colors', () => {
	it('returns the same palette entry for a program across repeated uses', () => {
		const programId = '93e7e012-f595-49a3-a2cc-46d60f508fcf';
		expect(programColor(programId)).toBe(programColor(programId));
		expect(PROGRAM_COLOR_PALETTE).toContain(programColor(programId));
	});

	it('exposes the shared editor and miniature-track variables', () => {
		expect(programColorStyle('2ba750b9-93ec-465d-8344-d1f471d180b0')).toEqual({
			'--program-color': expect.stringMatching(/^#/),
			'--program-color-dark': expect.stringMatching(/^#/),
			'--program-color-glow': expect.stringContaining('rgba('),
			'--program-color-foreground': '#ffffff',
		});
	});

	it('provides 32 distinct backgrounds with white text', () => {
		expect(PROGRAM_COLOR_PALETTE).toHaveLength(32);
		expect(new Set(PROGRAM_COLOR_PALETTE.map(color => color.solid)).size).toBe(PROGRAM_COLOR_PALETTE.length);
		for (const color of PROGRAM_COLOR_PALETTE) {
			expect(color.foreground).toBe('#ffffff');
		}
	});

	it('keeps white text readable throughout every program gradient', () => {
		for (const color of PROGRAM_COLOR_PALETTE) {
			for (let step = 0; step <= 100; step += 1) {
				expect(contrastRatio(interpolate(color.solid, color.dark, step / 100), color.foreground))
					.toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('keeps the unassigned fallback stable and exposes all palette entries through hashing', () => {
		expect(programColorStyle(null)).toEqual(programColorStyle('unassigned-program'));
		const assigned = new Set(Array.from({ length: 1024 }, (_, index) => programColor(`program-${index}`)));
		expect(assigned.size).toBe(PROGRAM_COLOR_PALETTE.length);
	});
});
