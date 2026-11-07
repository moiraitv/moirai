import type { ProgramConfig, SchedulingProgram } from '@moirai/shared';
import { stableJsonFingerprint } from '../stable-json.js';

/** Server-owned compatibility for AI cursors written before exclusion sets shared an identity. */
export type CursorCompatibleProgram = SchedulingProgram & { legacyAiCursorFingerprint?: string };

/** Omit server-owned cursor compatibility metadata from a public Program response. */
export function publicSchedulingProgram(program: CursorCompatibleProgram): SchedulingProgram {
	if (program.legacyAiCursorFingerprint === undefined) {
		return program;
	}
	const { legacyAiCursorFingerprint: _legacy, ...publicProgram } = program;
	void _legacy;
	return publicProgram;
}

/** Normalize both generations of exclusions while retaining the pre-upgrade fingerprint. */
export function aiCursorFingerprints(config: ProgramConfig): { fingerprint: string; emptyLegacy: string; legacy?: string } | undefined {
	if (config.type !== 'content' || config.source.type !== 'ai') {
		return undefined;
	}

	const { audioPreferences: _audio, subtitlePreferences: _subtitles, graphicsAssignment: _graphics, ...rest } = config;
	const { exclusions: _exclusions, excludedItemIds, ...source } = config.source;
	void _audio;
	void _subtitles;
	void _graphics;
	void _exclusions;
	return {
		fingerprint: stableJsonFingerprint({ ...rest, source }),
		emptyLegacy: stableJsonFingerprint({ ...rest, source: { ...source, excludedItemIds: [] } }),
		...(excludedItemIds?.length ? { legacy: stableJsonFingerprint({ ...rest, source: { ...source, excludedItemIds } }) } : {}),
	};
}

/** Retain one pre-upgrade identity across exclusion edits before a channel next saves its cursor. */
export function preserveLegacyAiCursor(current: CursorCompatibleProgram, config: ProgramConfig): string | undefined {
	const previous = aiCursorFingerprints(current.config);
	const next = aiCursorFingerprints(config);
	if (!previous || !next || previous.fingerprint !== next.fingerprint) {
		return undefined;
	}
	return current.legacyAiCursorFingerprint ?? (previous.legacy !== next.legacy ? previous.legacy : undefined);
}
