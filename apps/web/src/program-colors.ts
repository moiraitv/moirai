/** Stable background and contrasting text colors assigned to one program. */
export interface ProgramColor {
	solid: string;
	dark: string;
	glow: string;
	foreground: string;
}

/** Curated dark gradients keep white text readable across every program background. */
const PROGRAM_COLOR_BASES = [
	{ solid: '#087a52', dark: '#064a38', glow: 'rgba(8, 122, 82, 0.24)' },
	{ solid: '#186bb3', dark: '#123e70', glow: 'rgba(24, 107, 179, 0.24)' },
	{ solid: '#8245b4', dark: '#492766', glow: 'rgba(130, 69, 180, 0.24)' },
	{ solid: '#aa4e19', dark: '#66300f', glow: 'rgba(170, 78, 25, 0.24)' },
	{ solid: '#b33048', dark: '#691c30', glow: 'rgba(179, 48, 72, 0.24)' },
	{ solid: '#087780', dark: '#05474f', glow: 'rgba(8, 119, 128, 0.24)' },
	{ solid: '#846600', dark: '#504000', glow: 'rgba(132, 102, 0, 0.24)' },
	{ solid: '#5056b2', dark: '#2e326c', glow: 'rgba(80, 86, 178, 0.24)' },
	{ solid: '#187444', dark: '#104529', glow: 'rgba(24, 116, 68, 0.24)' },
	{ solid: '#2860a9', dark: '#193965', glow: 'rgba(40, 96, 169, 0.24)' },
	{ solid: '#934093', dark: '#572658', glow: 'rgba(147, 64, 147, 0.24)' },
	{ solid: '#9d5625', dark: '#5f3418', glow: 'rgba(157, 86, 37, 0.24)' },
	{ solid: '#a8345c', dark: '#641f3c', glow: 'rgba(168, 52, 92, 0.24)' },
	{ solid: '#126f8c', dark: '#0c4257', glow: 'rgba(18, 111, 140, 0.24)' },
	{ solid: '#786d16', dark: '#49420e', glow: 'rgba(120, 109, 22, 0.24)' },
	{ solid: '#604da8', dark: '#392e66', glow: 'rgba(96, 77, 168, 0.24)' },
	{ solid: '#32732c', dark: '#20471b', glow: 'rgba(50, 115, 44, 0.24)' },
	{ solid: '#3455a4', dark: '#202f65', glow: 'rgba(52, 85, 164, 0.24)' },
	{ solid: '#a0347b', dark: '#601d4b', glow: 'rgba(160, 52, 123, 0.24)' },
	{ solid: '#a5442d', dark: '#632a1e', glow: 'rgba(165, 68, 45, 0.24)' },
	{ solid: '#b02d35', dark: '#691a23', glow: 'rgba(176, 45, 53, 0.24)' },
	{ solid: '#087967', dark: '#06483f', glow: 'rgba(8, 121, 103, 0.24)' },
	{ solid: '#8a6018', dark: '#533a10', glow: 'rgba(138, 96, 24, 0.24)' },
	{ solid: '#70469e', dark: '#432a60', glow: 'rgba(112, 70, 158, 0.24)' },
	{ solid: '#4a6e25', dark: '#2e4318', glow: 'rgba(74, 110, 37, 0.24)' },
	{ solid: '#235f87', dark: '#163951', glow: 'rgba(35, 95, 135, 0.24)' },
	{ solid: '#894865', dark: '#522b3e', glow: 'rgba(137, 72, 101, 0.24)' },
	{ solid: '#925827', dark: '#58351a', glow: 'rgba(146, 88, 39, 0.24)' },
	{ solid: '#983d4d', dark: '#5b242f', glow: 'rgba(152, 61, 77, 0.24)' },
	{ solid: '#24736d', dark: '#164640', glow: 'rgba(36, 115, 109, 0.24)' },
	{ solid: '#795c30', dark: '#49381e', glow: 'rgba(121, 92, 48, 0.24)' },
	{ solid: '#56589a', dark: '#33355c', glow: 'rgba(86, 88, 154, 0.24)' },
] as const;

/** Shared program colors use opaque white copy in guides, editors, and previews. */
export const PROGRAM_COLOR_PALETTE: readonly ProgramColor[] = PROGRAM_COLOR_BASES.map((color) => ({
	...color,
	foreground: '#ffffff',
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
