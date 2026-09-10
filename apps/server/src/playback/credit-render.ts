import { Liquid } from 'liquidjs';
import { MAX_CREDIT_TEMPLATE_LENGTH } from '@moirai/shared';

/** Escape metadata so authored ASS tags cannot be injected through catalog text. */
export function escapeAssText(value: unknown): string {
	return String(value ?? '').replaceAll('\\', '＼').replaceAll('{', '｛').replaceAll('}', '｝')
		.replace(/\r?\n/g, '\\N');
}

/** Format source-relative seconds using ASS centisecond precision. */
export function assTimestamp(value: unknown): string {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		throw new Error('ASS timestamps must be non-negative seconds');
	}

	const ticks = Math.round(seconds * 100);
	return `${Math.floor(ticks / 360_000)}:${String(Math.floor(ticks / 6_000) % 60).padStart(2, '0')}:${String(Math.floor(ticks / 100) % 60).padStart(2, '0')}.${String(ticks % 100).padStart(2, '0')}`;
}

/** Parse an ASS event timestamp, rejecting invalid or reversed intervals. */
function timestamp(value: string): number {
	const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid ASS timestamp: ${value.slice(0, 40)}`);
	}
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
}

/** Validate the generated document before it becomes a playback asset. */
export function validateAss(source: string): void {
	if (Buffer.byteLength(source) > 1_048_576) {
		throw new Error('Generated credits exceed 1 MiB');
	}
	if (!source.includes('[Script Info]') || !source.includes('[V4+ Styles]') || !source.includes('[Events]')) {
		throw new Error('Credits must contain ASS Script Info, V4+ Styles, and Events sections');
	}

	for (const [index, line] of source.split(/\r?\n/).entries()) {
		if (line.startsWith('Dialogue:')) {
			const fields = line.slice(9).split(',');
			if (fields.length < 10 || timestamp(fields[2]!) <= timestamp(fields[1]!)) {
				throw new Error(`Invalid ASS dialogue interval at line ${index + 1}`);
			}
		}
	}
}

/** Render a bounded Liquid document without filesystem tags or executable host objects. */
export async function renderCredits(source: string, context: Record<string, unknown>): Promise<string> {
	const engine = new Liquid({
		strictVariables: true,
		strictFilters: true,
		lenientIf: true,
		ownPropertyOnly: true,
		parseLimit: MAX_CREDIT_TEMPLATE_LENGTH,
		renderLimit: 500,
		memoryLimit: 1_048_576,
		outputEscape: escapeAssText,
	});
	for (const tag of ['include', 'render', 'layout']) {
		engine.registerTag(tag, { parse() {
			throw new Error('File-loading template tags are disabled'); 
		}, render() {
			return ''; 
		} });
	}
	engine.registerFilter('ass_time', assTimestamp);
	const result = await engine.parseAndRender(source, context) as string;
	validateAss(result);
	return result;
}
