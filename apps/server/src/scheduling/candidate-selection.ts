import type { SchedulableMedia } from '@moirai/shared';
import { hasSelectionCollision, selectionDuration, type SelectionContext, type SelectionFitMode } from './selection.js';

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
				return fitSeconds === null || selectionDuration(media) <= fitSeconds ? media : null;
			}
			continue;
		}

		const duration = fitSeconds === null ? 0 : selectionDuration(media);
		if (fitSeconds !== null && duration > fitSeconds) {
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
		return fallback && (fitSeconds === null || selectionDuration(fallback) <= fitSeconds) ? fallback : null;
	}
	return hasNonCollision ? preferred ?? repeated : fallback ?? fallbackRepeated;
}
