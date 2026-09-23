import type { Repository } from '../repository/index.js';
import type { TimelineCommit } from '../repository/contracts.js';

/** Only authoritative timeline mutations may cross from a read-only worker to its owner. */
export type MaterializationWrite
	= | { kind: 'pending'; channelIds: string[]; applyAfter: string; pendingSince: string }
		| { kind: 'failed'; channelId: string; message: string; failedAt: string }
		| { kind: 'commit'; input: TimelineCommit };

/** Acknowledged writes preserve occupancy order and expose stale-commit failures to the planner. */
export type MaterializationWriter = (write: MaterializationWrite) => Promise<void>;

/** Apply one worker proposal through the same transaction and revision checks as local generation. */
export function applyMaterializationWrite(repository: Repository, write: MaterializationWrite): void {
	if (write.kind === 'pending') {
		repository.markTimelinePending(write.channelIds, write.applyAfter, write.pendingSince);
	}
	else if (write.kind === 'failed') {
		repository.markTimelineFailed(write.channelId, write.message, write.failedAt);
	}
	else {
		repository.commitMaterializedTimeline(write.input);
	}
}
