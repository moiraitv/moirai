import type { SimilaritySeed } from './scheduling.js';

/** Persisted filler membership; deferred items retain their position ahead of later cycles. */
export interface FillerCycle {
	version: 1;
	cycle: number;
	itemIds: string[];
	remainingItemIds: string[];
}

/** Shared wire contract for selection state value. */
export type SelectionStateValue
	= (| { type: 'similarity'; seed: SimilaritySeed; consumedItemIds: string[]; recentSeeds?: string[][] | undefined }
		| { type: 'sequential'; nextIndex: number; lastItemId: string | null }
		| {
			type: 'shuffle';
			cycle: number;
			cycleItemIds: string[];
			remainingItemIds: string[];
			lastItemId: string | null;
		}
		| { type: 'random'; counter: number; lastItemId: string | null }
		| { type: 'weighted-random'; counter: number; lastItemId: string | null }
		| {
			type: 'sequence';
			entryIndex: number;
			selectedInEntry: number;
			completed: boolean;
			rotation?: {
				cycle: number;
				remaining: number[];
				order: number[];
				lastEntry: number | null;
			} | undefined;
		}) & { fillerCycle?: FillerCycle };

/** Shared wire contract for selection state record. */
export interface SelectionStateRecord {
	consumerKey: string;
	configFingerprint: string;
	value: SelectionStateValue;
	updatedAt: string;
}

