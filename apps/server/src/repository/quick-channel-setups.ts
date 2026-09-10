import { applyDefaultEncodingProfile } from './encoding-profiles.js';
import { eq, inArray } from 'drizzle-orm';
import {
	canonicalChannelNumberKey,
	canonicalIdentityKey,
	channelCreateSchema,
	effectiveChannelTvgId,
	type QuickChannelSetupCreate,
} from '@moirai/shared';
import type { QuickChannelSetupResult } from '@moirai/shared/api-contracts';
import type { MoiraiDatabase } from '../db/index.js';
import {
	channels,
	channelSchedules,
	libraries,
	mediaGroups,
	mediaItems,
	scheduleBoundaries,
	scheduleSlots,
	scheduleTemplates,
	schedulingPrograms,
} from '../db/schema.js';
import { SchedulingValidationError } from '../scheduling/validation.js';
import { libraryTypeMediaKind, quickSetupResources } from '../scheduling/quick-setup-resources.js';
import { ResourceIdentityConflictError } from './resource-identity.js';

/** Find a readable unused template name while preserving the requested base when possible. */
function availableTemplateName(
	transaction: Pick<MoiraiDatabase, 'select'>,
	channelName: string,
): string {
	let suffix = 1;
	while (true) {
		const ending = suffix === 1 ? ' Daily' : ` Daily (${suffix})`;
		const candidate = `${channelName.slice(0, 120 - ending.length).trimEnd()}${ending}`;
		const existing = transaction.select({ id: scheduleTemplates.id })
			.from(scheduleTemplates)
			.where(eq(scheduleTemplates.nameKey, canonicalIdentityKey(candidate)))
			.get();
		if (!existing) {
			return candidate;
		}

		suffix += 1;
	}
}

/** Own the atomic cross-domain persistence required by the Quick Setup workflow. */
export class QuickChannelSetupRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** Validate source ownership without reserving identities or writing any resources. */
	preview(input: QuickChannelSetupCreate, maxExplicitMediaItems: number): QuickChannelSetupResult {
		this.validateSource(input, maxExplicitMediaItems, this.db);
		let identity = 0;
		const result = quickSetupResources(
			input,
			availableTemplateName(this.db, input.channel.name),
			() => `00000000-0000-4000-8000-${String(++identity).padStart(12, '0')}`,
		);
		Object.assign(result.channel, applyDefaultEncodingProfile(this.db, channelCreateSchema.strip().parse(result.channel)));
		return result;
	}

	/** Check library compatibility and explicit member ownership through bounded queries. */
	private validateSource(
		input: QuickChannelSetupCreate,
		maxExplicitMediaItems: number,
		transaction: Pick<MoiraiDatabase, 'select'>,
	): void {
		const library = transaction.select({ id: libraries.id, typeKey: libraries.typeKey })
			.from(libraries)
			.where(eq(libraries.id, input.libraryId))
			.get();
		if (!library) {
			throw new SchedulingValidationError('Library not found');
		}
		if (library.typeKey !== input.scenario) {
			throw new SchedulingValidationError('The library is not compatible with this scenario');
		}

		const expectedKind = libraryTypeMediaKind(input.scenario);
		if (input.source.type === 'collection') {
			if (input.source.itemIds.length > maxExplicitMediaItems) {
				throw new SchedulingValidationError(
					`The program exceeds the configured ${maxExplicitMediaItems.toLocaleString()}-item limit`,
				);
			}

			const items = transaction.select({
				id: mediaItems.id,
				libraryId: mediaItems.libraryId,
				kind: mediaItems.kind,
			}).from(mediaItems).where(inArray(mediaItems.id, input.source.itemIds)).all();
			if (
				items.length !== input.source.itemIds.length
				|| items.some((item) => item.libraryId !== input.libraryId || item.kind !== expectedKind)
			) {
				throw new SchedulingValidationError(
					'Every selected item must be compatible media from the selected library',
				);
			}
		}
		if (input.source.type === 'group-collection') {
			const groups = transaction.select({
				id: mediaGroups.id,
				libraryId: mediaGroups.libraryId,
				kind: mediaGroups.kind,
			}).from(mediaGroups).where(inArray(mediaGroups.id, input.source.groupIds)).all();
			if (
				groups.length !== input.source.groupIds.length
				|| groups.some((group) =>
					group.libraryId !== input.libraryId || !['show', 'season'].includes(group.kind))
			) {
				throw new SchedulingValidationError(
					'Every selected group must be a show or season from the selected library',
				);
			}
		}

	}

	/** Create a program, continuous daily template, channel, and base assignment together. */
	create(input: QuickChannelSetupCreate, maxExplicitMediaItems: number): QuickChannelSetupResult {
		return this.db.transaction((transaction) => {
			this.validateSource(input, maxExplicitMediaItems, transaction);
			const programNameKey = canonicalIdentityKey(input.programName);
			const programConflict = transaction.select({ id: schedulingPrograms.id })
				.from(schedulingPrograms)
				.where(eq(schedulingPrograms.nameKey, programNameKey))
				.get();
			if (programConflict) {
				throw new ResourceIdentityConflictError('program');
			}

			const channelNumberKey = canonicalChannelNumberKey(input.channel.number);
			const channelConflict = transaction.select({ id: channels.id })
				.from(channels)
				.where(eq(channels.numberKey, channelNumberKey))
				.get();
			if (channelConflict) {
				throw new ResourceIdentityConflictError('channel-number');
			}

			const templateName = availableTemplateName(transaction, input.channel.name);
			const { program, template, channel, schedule } = quickSetupResources(input, templateName);
			const templateId = template.id;
			const channelId = channel.id;
			const timestamp = program.createdAt;
			const channelConfig = applyDefaultEncodingProfile(transaction, channelCreateSchema.strip().parse(channel));
			Object.assign(channel, channelConfig);

			transaction.insert(schedulingPrograms).values({ ...program, nameKey: programNameKey }).run();
			transaction.insert(scheduleTemplates).values({
				id: template.id,
				name: template.name,
				nameKey: canonicalIdentityKey(template.name),
				period: template.period,
				defaultFiller: template.defaultFiller,
				createdAt: timestamp,
				updatedAt: timestamp,
			}).run();
			transaction.insert(scheduleSlots).values({
				...template.slots[0]!,
				templateId,
				position: 0,
			}).run();
			transaction.insert(scheduleBoundaries).values({
				...template.boundaries[0]!,
				templateId,
				position: 0,
			}).run();
			transaction.insert(channels).values({
				id: channelId,
				number: channel.number,
				numberKey: channelNumberKey,
				name: channel.name,
				effectiveTvgId: effectiveChannelTvgId(channel),
				config: channelConfig,
				createdAt: timestamp,
				updatedAt: timestamp,
			}).run();
			transaction.insert(channelSchedules).values({
				channelId,
				defaultTemplateId: templateId,
				config: {
					defaultTemplateId: templateId,
					layers: [],
					defaultFiller: null,
				},
				createdAt: timestamp,
				updatedAt: timestamp,
			}).run();

			return { program, template, channel, schedule } as QuickChannelSetupResult;
		});
	}
}
