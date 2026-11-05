/** Shared wire contract for timeline materialization health. */
export type TimelineMaterializationHealth = 'ready' | 'pending' | 'generating' | 'failed';

/** Shared wire contract for channel timeline materialization status. */
export interface ChannelTimelineMaterializationStatus {
	channelId: string;
	health: TimelineMaterializationHealth;
	windowStart: string | null;
	windowEnd: string | null;
	committedAt: string | null;
	pendingSince: string | null;
	applyAfter: string | null;
	lastError: string | null;
}
