import { randomUUID } from 'node:crypto';
import {
	SECONDS_PER_SCHEDULING_DAY, channelCreateSchema,
	type Channel, type ChannelSchedule, type ProgramConfig, type QuickChannelSetupCreate,
	type ScheduleTemplate, type SchedulingProgram,
} from '@moirai/shared';
import type { QuickChannelSetupResult } from '@moirai/shared/api-contracts';
import { currentTimestamp } from '../time.js';

/** Resolve the indexed media kind owned by a built-in or fallback library type. */
export function libraryTypeMediaKind(typeKey: string): string {
	if (typeKey === 'movies') {
		return 'movie';
	}
	if (typeKey === 'shows') {
		return 'episode';
	}
	if (typeKey === 'music-videos') {
		return 'music-video';
	}

	return 'other';
}


/** Construct identical continuous scheduling resources for persistence or a read-only sample. */
export function quickSetupResources(
	input: QuickChannelSetupCreate,
	templateName: string,
	createId: () => string = randomUUID,
): QuickChannelSetupResult {
	const timestamp = currentTimestamp();
	const programId = createId();
	const templateId = createId();
	const slotId = createId();
	const boundaryId = createId();
	const channelId = createId();
	const expectedKind = libraryTypeMediaKind(input.scenario);
	const source = input.source.type === 'library-query'
		? {
			...input.source,
			type: 'library-query' as const,
			libraryId: input.libraryId,
			kinds: [expectedKind],
		}
		: input.source.type === 'group-collection'
			? {
				type: 'group-collection' as const,
				libraryId: input.libraryId,
				groupIds: input.source.groupIds,
			}
			: {
				type: 'collection' as const,
				libraryId: input.libraryId,
				itemIds: input.source.itemIds,
				additionBatches: [input.source.itemIds],
				sort: { type: 'manual' as const, itemIds: input.source.itemIds },
			};
	const programConfig: ProgramConfig = { type: 'content', source, strategy: input.strategy };
	const program: SchedulingProgram = {
		id: programId,
		name: input.programName,
		config: programConfig,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const template: ScheduleTemplate = {
		id: templateId!,
		name: templateName,
		period: 'day',
		defaultFiller: null,
		slots: [{
			id: slotId!,
			startSeconds: 0,
			programId: programId!,
			stateScope: 'persistent',
			startEligibility: { type: 'allow-overrun' },
			filler: { mode: 'inherit' },
		}],
		boundaries: [{
			id: boundaryId!,
			leftSlotId: slotId!,
			rightSlotId: slotId!,
			targetSeconds: SECONDS_PER_SCHEDULING_DAY,
			policy: 'finish-left',
			maxDriftSeconds: null,
			fallback: 'reject-start',
			earlyStartMaxDriftSeconds: 0,
		}],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const channelConfig = channelCreateSchema.parse(input.channel);
	const channel: Channel = {
		...channelConfig,
		id: channelId!,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const schedule: ChannelSchedule = {
		channelId: channelId!,
		defaultTemplateId: templateId!,
		layers: [],
		defaultFiller: null,
		createdAt: timestamp,
		updatedAt: timestamp,
	};

	return { program, template, channel, schedule } as QuickChannelSetupResult;
}
