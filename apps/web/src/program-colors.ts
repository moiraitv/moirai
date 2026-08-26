/** Stable background and contrasting text colors assigned to one program. */
export interface ProgramColor {
	solid: string;
	dark: string;
	glow: string;
	foreground: string;
}

/** Base gradients used to give each program a stable visual identity. */
const PROGRAM_COLOR_BASES = [
	{ solid: '#20b985', dark: '#0b7058', glow: 'rgba(32, 185, 133, 0.24)' },
	{ solid: '#3c91df', dark: '#225b91', glow: 'rgba(60, 145, 223, 0.24)' },
	{ solid: '#9b5bd0', dark: '#5f387f', glow: 'rgba(155, 91, 208, 0.24)' },
	{ solid: '#e1853d', dark: '#8e4f25', glow: 'rgba(225, 133, 61, 0.24)' },
	{ solid: '#dc565c', dark: '#8b3139', glow: 'rgba(220, 86, 92, 0.24)' },
	{ solid: '#28a8b8', dark: '#176875', glow: 'rgba(40, 168, 184, 0.24)' },
	{ solid: '#c8a03a', dark: '#796021', glow: 'rgba(200, 160, 58, 0.24)' },
	{ solid: '#7178dc', dark: '#43498e', glow: 'rgba(113, 120, 220, 0.24)' },
] as const;

/** Light text color used on dark program gradients. */
const LIGHT_FOREGROUND = '#f7fffc';
/** Dark text color used on light program gradients. */
const DARK_FOREGROUND = '#06120f';

/** Parse a hexadecimal color into normalized RGB channels. */
function hexChannels(value: string): [number, number, number] {
	return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [
		number,
		number,
		number,
	];
}

/** Calculate WCAG relative luminance for one RGB color. */
function relativeLuminance(channels: readonly number[]): number {
	const [red, green, blue] = channels.map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** Calculate the WCAG contrast ratio between two colors. */
function contrastRatio(left: readonly number[], right: readonly number[]): number {
	const leftLuminance = relativeLuminance(left);
	const rightLuminance = relativeLuminance(right);
	return (
		(Math.max(leftLuminance, rightLuminance) + 0.05)
		/ (Math.min(leftLuminance, rightLuminance) + 0.05)
	);
}

/** Choose readable slot text against the midpoint of the rendered program gradient. */
function programForeground(solid: string, dark: string): string {
	const solidChannels = hexChannels(solid);
	const darkChannels = hexChannels(dark);
	const midpoint = solidChannels.map((channel, index) =>
		Math.round((channel + darkChannels[index]!) / 2));
	return contrastRatio(midpoint, hexChannels(LIGHT_FOREGROUND))
		>= contrastRatio(midpoint, hexChannels(DARK_FOREGROUND))
		? LIGHT_FOREGROUND
		: DARK_FOREGROUND;
}

/** Program palette with precomputed readable foreground colors. */
export const PROGRAM_COLOR_PALETTE: readonly ProgramColor[] = PROGRAM_COLOR_BASES.map((color) => ({
	...color,
	foreground: programForeground(color.solid, color.dark),
}));

/** Derive a repeatable visual identity without storing presentation data in scheduling contracts. */
export function programColor(programId: string): ProgramColor {
	let hash = 2_166_136_261;
	for (let index = 0; index < programId.length; index += 1) {
		hash ^= programId.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return PROGRAM_COLOR_PALETTE[(hash >>> 0) % PROGRAM_COLOR_PALETTE.length]!;
}

/** CSS custom properties consumed by both compact and editable schedule tracks. */
export function programColorStyle(programId: string | null): Record<string, string> {
	const color = programColor(programId ?? 'unassigned-program');
	return {
		'--program-color': color.solid,
		'--program-color-dark': color.dark,
		'--program-color-glow': color.glow,
		'--program-color-foreground': color.foreground,
	};
}
