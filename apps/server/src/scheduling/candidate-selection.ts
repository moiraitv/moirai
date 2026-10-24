import type { SchedulableMedia } from '@moirai/shared';
import { hasSelectionCollision, selectionDuration, type SelectionContext, type SelectionFitMode } from './selection.js';
import { durationMilliseconds } from '@moirai/shared';

/** Select in authored order, or retain the longest fit, without expanding unused candidates. */
export function selectOrderedCandidate(
	ordered: SchedulableMedia[],
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode,
	strictFirst = false,
	avoidItemId: string | null = null,
): SchedulableMedia | null {
	const bestFit = fitSeconds !== null && fitMode === 'best-fit';
	const fitMilliseconds = fitSeconds === null ? null : durationMilliseconds(fitSeconds);
	let hasNonCollision = false;
	let preferred: SchedulableMedia | null = null;
	let repeated: SchedulableMedia | null = null;
	let fallback: SchedulableMedia | null = null;
	let fallbackRepeated: SchedulableMedia | null = null;
	let preferredDuration = -Infinity;
	let repeatedDuration = -Infinity;
	let fallbackDuration = -Infinity;
	let fallbackRepeatedDuration = -Infinity;
	for (const media of ordered) {
		const collision = hasSelectionCollision(media, context);
		if (!collision) {
			hasNonCollision = true;
		}
		// Sequential primary fitting rejects its first collision-free item rather than skipping it.
		if (strictFirst && !bestFit) {
			fallback ??= media;
			if (!collision) {
				return fitMilliseconds === null || durationMilliseconds(selectionDuration(media, context)) <= fitMilliseconds ? media : null;
			}
			continue;
		}

		const duration = fitMilliseconds === null ? 0 : durationMilliseconds(selectionDuration(media, context));
		if (fitMilliseconds !== null && duration > fitMilliseconds) {
			continue;
		}
		const repeat = media.id === avoidItemId;
		if (!collision && !repeat) {
			if (!bestFit) {
				return media;
			}
			if (duration > preferredDuration) {
				preferred = media;
				preferredDuration = duration;
			}
		}
		else if (!collision && (!repeated || (bestFit && duration > repeatedDuration))) {
			repeated = media;
			repeatedDuration = duration;
		}
		else if (collision && !repeat && (!fallback || (bestFit && duration > fallbackDuration))) {
			fallback = media;
			fallbackDuration = duration;
		}
		else if (collision && repeat && (!fallbackRepeated || (bestFit && duration > fallbackRepeatedDuration))) {
			fallbackRepeated = media;
			fallbackRepeatedDuration = duration;
		}
	}

	if (strictFirst && !bestFit) {
		return fallback && (fitMilliseconds === null || durationMilliseconds(selectionDuration(fallback, context)) <= fitMilliseconds) ? fallback : null;
	}
	return hasNonCollision ? preferred ?? repeated : fallback ?? fallbackRepeated;
}
