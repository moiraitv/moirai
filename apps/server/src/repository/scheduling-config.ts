import { validateCreditReference } from './subtitle-validation.js';
import { createHash, randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type {
	ChannelSchedule,
	ChannelScheduleConfig,
	ContentSource,
	ProgramCreate,
	ProgramConfig,
	ProgramUpdate,
	ScheduleTemplate,
	ScheduleTemplateCreate,
	ScheduleTemplateUpdate,
	SchedulingProgram,
} from '@moirai/shared';
import {
	canonicalIdentityKey,
	channelScheduleConfigSchema,
	DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD,
	programConfigSchema,
	updateSelectedMediaAdditionOrder,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	channels,
	channelScheduleLayers,
	channelSchedules,
	materializedTimelineSegments,
	mediaItemAliases,
	mediaGroups,
	mediaItems,
	scheduleBoundaries,
	scheduleSlots,
	scheduleTemplates,
	schedulingPrograms,
	selectionStates,
	timelineMaterializations,
} from '../db/schema.js';
import {
	SchedulingValidationError,
	validateChannelSchedule,
	validatePrograms,
	validateTemplate,
} from '../scheduling/validation.js';
import {
	ResourceIdentityConflictError,
	SchedulingIdentityConflictError,
} from './resource-identity.js';
import type { ProgramItemAppendResult } from './contracts.js';
import { currentTimestamp } from '../time.js';

/** Bind a confirmation to ordered identifiers or their canonical set according to playback semantics. */
function programItemAdditionConfirmationToken(itemIds: string[], orderSensitive: boolean): string {
	const comparisonMode = orderSensitive ? 'ordered' : 'set';
	const confirmationIds = orderSensitive ? itemIds : [...itemIds].sort();
	return createHash('sha256')
		.update(
			`moirai-program-item-addition-v1\0${comparisonMode}\0${JSON.stringify(confirmationIds)}`,
		)
		.digest('hex');
}

/**
 * Own authored programs, templates, and layered channel schedule configuration. This repository
 * validates cross-resource references and stable identifiers before persisting configuration, while
 * leaving generated timeline state to the execution repository.
 */
export class SchedulingConfigurationRepository {
	constructor(protected readonly db: MoiraiDatabase) {}

	/** List reusable scheduling programs. */
	async listPrograms(): Promise<SchedulingProgram[]> {
		const rows = await this.db.select().from(schedulingPrograms).orderBy(asc(schedulingPrograms.name));
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			config: programConfigSchema.parse(row.config),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}));
	}

	/** Return one reusable scheduling program. */
	async getProgram(id: string): Promise<SchedulingProgram | null> {
		const [program] = await this.db
			.select()
			.from(schedulingPrograms)
			.where(eq(schedulingPrograms.id, id));
		return program
			? {
				id: program.id,
				name: program.name,
				config: programConfigSchema.parse(program.config),
				createdAt: program.createdAt,
				updatedAt: program.updatedAt,
			}
			: null;
	}

	/** Persist a reusable scheduling program. */
	async createProgram(input: ProgramCreate): Promise<SchedulingProgram> {
		validateCreditReference(this.db, input.config.subtitlePreferences);
		const timestamp = currentTimestamp();
		const config = this.normalizeCollectionAdditionOrder(null, input.config);
		const program: SchedulingProgram = {
			id: randomUUID(),
			...input,
			config,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		validatePrograms([...(await this.listPrograms()), program]);
		const nameKey = canonicalIdentityKey(program.name);
		const [conflict] = await this.db
			.select({ id: schedulingPrograms.id })
			.from(schedulingPrograms)
			.where(eq(schedulingPrograms.nameKey, nameKey))
			.limit(1);
		if (conflict) {
			throw new ResourceIdentityConflictError('program');
		}

		await this.db.insert(schedulingPrograms).values({ ...program, nameKey });
		return program;
	}

	/** Resolve the library that owns a content source when its contract does not carry one directly. */
	private async contentSourceLibraryId(source: ContentSource): Promise<string | null> {
		if ('libraryId' in source) {
			return source.libraryId;
		}

		if (source.type === 'group') {
			const [group] = await this.db
				.select({ libraryId: mediaGroups.libraryId })
				.from(mediaGroups)
				.where(eq(mediaGroups.id, source.groupId));
			return group?.libraryId ?? null;
		}

		const [item] = await this.db
			.select({ libraryId: mediaItems.libraryId })
			.from(mediaItems)
			.where(eq(mediaItems.id, source.itemId));
		if (item) {
			return item.libraryId;
		}

		const [alias] = await this.db
			.select({ libraryId: mediaItems.libraryId })
			.from(mediaItemAliases)
			.innerJoin(mediaItems, eq(mediaItems.id, mediaItemAliases.itemId))
			.where(eq(mediaItemAliases.aliasId, source.itemId));
		return alias?.libraryId ?? null;
	}

	/** Preserve immutable collection insertion history while grouping one update's new IDs together. */
	private normalizeCollectionAdditionOrder(
		current: ProgramConfig | null,
		updated: ProgramConfig,
	): ProgramConfig {
		if (updated.type !== 'content' || updated.source.type !== 'collection') {
			return updated;
		}

		const currentSource = current?.type === 'content' && current.source.type === 'collection'
			? current.source
			: null;
		const currentItemIds = new Set(currentSource?.itemIds ?? []);
		const addedItem = updated.source.itemIds.some((itemId) => !currentItemIds.has(itemId));
		const additionOrder = updateSelectedMediaAdditionOrder(
			currentSource?.itemIds ?? [],
			currentSource?.additionBatches,
			updated.source.itemIds,
		);
		const retainAdditionBatches = currentSource === null
			|| currentSource.additionBatches !== undefined
			|| addedItem;
		const updatedSource = { ...updated.source };
		delete updatedSource.additionBatches;
		return {
			...updated,
			source: {
				...updatedSource,
				itemIds: additionOrder.itemIds,
				...(retainAdditionBatches
					? { additionBatches: additionOrder.additionBatches }
					: {}),
			},
		};
	}

	/** Reject structural program changes that would invalidate its established source identity. */
	private async validateProgramStructure(
		current: ProgramConfig,
		updated: ProgramConfig,
	): Promise<void> {
		if (current.type !== updated.type) {
			throw new SchedulingValidationError('Program type cannot be changed after creation');
		}

		if (current.type !== 'content' || updated.type !== 'content') {
			return;
		}

		if (current.source.type !== updated.source.type) {
			throw new SchedulingValidationError('Program source type cannot be changed after creation');
		}
		const currentReferenceId = current.source.type === 'item'
			? current.source.itemId
			: current.source.type === 'group'
				? current.source.groupId
				: null;
		const updatedReferenceId = updated.source.type === 'item'
			? updated.source.itemId
			: updated.source.type === 'group'
				? updated.source.groupId
				: null;

		const [currentLibraryId, updatedLibraryId] = await Promise.all([
			this.contentSourceLibraryId(current.source),
			this.contentSourceLibraryId(updated.source),
		]);
		if (
			currentLibraryId !== updatedLibraryId
			&& (
				currentLibraryId !== null
				|| updatedLibraryId !== null
				|| currentReferenceId !== updatedReferenceId
			)
		) {
			throw new SchedulingValidationError('Program library cannot be changed after creation');
		}
		if (
			currentReferenceId !== updatedReferenceId
			&& (currentLibraryId === null || updatedLibraryId === null)
		) {
			throw new SchedulingValidationError('Program library cannot be changed after creation');
		}
	}

	/** Replace a program configuration while preserving its identity. */
	async updateProgram(id: string, input: ProgramUpdate): Promise<SchedulingProgram | null> {
		const current = await this.getProgram(id);
		if (!current) {
			return null;
		}
		const config = input.config
			? this.normalizeCollectionAdditionOrder(current.config, input.config)
			: current.config;
		if (input.config) {
			await this.validateProgramStructure(current.config, config);
		}

		if (current.config.subtitlePreferences?.creditsTemplateId !== config.subtitlePreferences?.creditsTemplateId) {
			validateCreditReference(this.db, config.subtitlePreferences);
		}

		const updated: SchedulingProgram = {
			...current,
			name: input.name ?? current.name,
			config,
			updatedAt: currentTimestamp(),
		};
		const programs = (await this.listPrograms()).map((program) =>
			program.id === id ? updated : program);
		validatePrograms(programs);
		const nameKey = canonicalIdentityKey(updated.name);
		const [conflict] = await this.db
			.select({ id: schedulingPrograms.id })
			.from(schedulingPrograms)
			.where(eq(schedulingPrograms.nameKey, nameKey))
			.limit(1);
		if (conflict && conflict.id !== id) {
			throw new ResourceIdentityConflictError('program');
		}

		await this.db
			.update(schedulingPrograms)
			.set({ name: updated.name, nameKey, config: updated.config, updatedAt: updated.updatedAt })
			.where(eq(schedulingPrograms.id, id));
		return updated;
	}

	/** Atomically append canonical items to a compatible same-library collection program. */
	appendProgramItems(
		id: string,
		libraryId: string,
		itemIds: string[],
		confirmedAdditionToken?: string,
		maxItemCount = DEFAULT_MAX_EXPLICIT_MEDIA_ITEMS,
	): ProgramItemAppendResult {
		return this.db.transaction((tx): ProgramItemAppendResult => {
			const [row] = tx.select().from(schedulingPrograms)
				.where(eq(schedulingPrograms.id, id)).limit(1).all();
			if (!row) {
				return { status: 'not-found' };
			}

			const config = programConfigSchema.parse(row.config);
			if (
				config.type !== 'content'
				|| config.source.type !== 'collection'
				|| config.source.libraryId !== libraryId
			) {
				return { status: 'incompatible' };
			}

			// Resolve absorbed multipart identifiers before comparing or rewriting the collection.
			const authoredCurrentIds = config.source.itemIds;
			const authoredAdditionBatches = config.source.additionBatches;
			const authoredManualIds = config.source.sort.type === 'manual'
				? config.source.sort.itemIds
				: [];
			const candidateIds = [
				...new Set([
					...authoredCurrentIds,
					...(authoredAdditionBatches?.flat() ?? []),
					...authoredManualIds,
					...itemIds,
				]),
			];
			const aliases = candidateIds.length > 0
				? tx.select({ aliasId: mediaItemAliases.aliasId, itemId: mediaItemAliases.itemId })
					.from(mediaItemAliases)
					.where(inArray(mediaItemAliases.aliasId, candidateIds)).all()
				: [];
			const aliasMap = new Map(aliases.map((alias) => [alias.aliasId, alias.itemId]));
			/** Resolve one stored or incoming compatibility identifier to its current item. */
			function canonicalId(itemId: string): string {
				return aliasMap.get(itemId) ?? itemId;
			}

			const currentIds: string[] = [];
			const additionBatches: string[][] = [];
			const current = new Set<string>();
			for (const batch of authoredAdditionBatches
				?? authoredCurrentIds.map((itemId) => [itemId])) {
				const canonicalBatch: string[] = [];
				for (const itemId of batch) {
					const canonical = canonicalId(itemId);
					if (!current.has(canonical)) {
						current.add(canonical);
						currentIds.push(canonical);
						canonicalBatch.push(canonical);
					}
				}
				if (canonicalBatch.length > 0) {
					additionBatches.push(canonicalBatch);
				}
			}
			const manualIds = [...new Set(authoredManualIds.map(canonicalId))];
			const incomingIds = [...new Set(itemIds.map(canonicalId))];
			const additions = incomingIds.filter((itemId) => !current.has(itemId));
			const additionsOrderSensitive = config.strategy.type === 'sequential';
			const confirmationToken = programItemAdditionConfirmationToken(
				additions,
				additionsOrderSensitive,
			);
			const alreadySelectedCount = incomingIds.length - additions.length;
			const remainingItemCount = maxItemCount - currentIds.length;
			const normalizedCurrent = currentIds.length !== authoredCurrentIds.length
				|| currentIds.some((itemId, index) => itemId !== authoredCurrentIds[index]);
			const normalizedAdditionBatches = authoredAdditionBatches !== undefined
				&& JSON.stringify(additionBatches) !== JSON.stringify(authoredAdditionBatches);
			const normalizedManual = config.source.sort.type === 'manual'
				&& (manualIds.length !== authoredManualIds.length
					|| manualIds.some((itemId, index) => itemId !== authoredManualIds[index]));
			if (additions.length > remainingItemCount) {
				return {
					status: 'capacity',
					addedItemCount: additions.length,
					alreadySelectedCount,
					remainingItemCount,
				};
			}
			if (
				confirmedAdditionToken !== undefined
				&& confirmedAdditionToken !== confirmationToken
			) {
				return {
					status: 'confirmation-required',
					addedItemCount: additions.length,
					addedItemIds: additions,
					alreadySelectedCount,
					confirmationToken,
				};
			}
			if (
				additions.length > PROGRAM_ITEM_ADDITION_CONFIRMATION_THRESHOLD
				&& confirmedAdditionToken === undefined
			) {
				return {
					status: 'confirmation-required',
					addedItemCount: additions.length,
					addedItemIds: additions,
					alreadySelectedCount,
					confirmationToken,
				};
			}
			if (
				additions.length === 0
				&& !normalizedCurrent
				&& !normalizedAdditionBatches
				&& !normalizedManual
			) {
				return {
					status: 'updated',
					program: {
						id: row.id,
						name: row.name,
						config,
						createdAt: row.createdAt,
						updatedAt: row.updatedAt,
					},
					changed: false,
					addedItemCount: 0,
					alreadySelectedCount,
				};
			}

			const timestamp = currentTimestamp();
			const updated: SchedulingProgram = {
				id: row.id,
				name: row.name,
				config: {
					...config,
					source: {
						...config.source,
						itemIds: [...currentIds, ...additions],
						additionBatches: [
							...additionBatches,
							...(additions.length > 0 ? [additions] : []),
						],
						sort: config.source.sort.type === 'manual'
							? {
								type: 'manual',
								itemIds: [...manualIds, ...additions],
							}
							: config.source.sort,
					},
				},
				createdAt: row.createdAt,
				updatedAt: timestamp,
			};
			tx.update(schedulingPrograms)
				.set({ config: updated.config, updatedAt: timestamp })
				.where(eq(schedulingPrograms.id, id)).run();
			return {
				status: 'updated',
				program: updated,
				changed: true,
				addedItemCount: additions.length,
				alreadySelectedCount,
			};
		});
	}

	/** Delete a program only when no sequence, slot, or filler configuration references it. */
	async deleteProgram(id: string): Promise<boolean> {
		const programs = await this.listPrograms();
		const referencedBySequence = programs.some(
			(program) =>
				program.id !== id
				&& program.config.type === 'sequence'
				&& program.config.entries.some((entry) => entry.programId === id),
		);
		const [slotReference] = await this.db
			.select({ id: scheduleSlots.id })
			.from(scheduleSlots)
			.where(eq(scheduleSlots.programId, id))
			.limit(1);
		const templates = await this.listScheduleTemplates();
		const referencedAsFiller = templates.some(
			(template) =>
				template.defaultFiller?.programId === id
				|| template.slots.some(
					(slot) => slot.filler.mode === 'configured' && slot.filler.config.programId === id,
				),
		);
		const schedules = await this.db.select().from(channelSchedules);
		const referencedByChannel = schedules.some(
			(schedule) => schedule.config.defaultFiller?.programId === id,
		);
		if (referencedBySequence || slotReference || referencedAsFiller || referencedByChannel) {
			throw new SchedulingValidationError('The program is still referenced by a schedule');
		}

		const result = await this.db.delete(schedulingPrograms).where(eq(schedulingPrograms.id, id));
		return result.changes > 0;
	}

	/** List authored daily schedule templates. */
	async listScheduleTemplates(): Promise<ScheduleTemplate[]> {
		const [templates, slots, boundaries] = await Promise.all([
			this.db.select().from(scheduleTemplates).orderBy(asc(scheduleTemplates.name)),
			this.db.select().from(scheduleSlots).orderBy(asc(scheduleSlots.position)),
			this.db.select().from(scheduleBoundaries).orderBy(asc(scheduleBoundaries.position)),
		]);
		return templates.map((template) => ({
			id: template.id,
			name: template.name,
			period: template.period,
			createdAt: template.createdAt,
			updatedAt: template.updatedAt,
			defaultFiller: template.defaultFiller ?? null,
			slots: slots
				.filter((slot) => slot.templateId === template.id)
				.map((slot) => ({
					id: slot.id,
					startSeconds: slot.startSeconds,
					programId: slot.programId,
					stateScope: slot.stateScope,
					startEligibility: slot.startEligibility,
					filler: slot.filler,
				})),
			boundaries: boundaries
				.filter((boundary) => boundary.templateId === template.id)
				.map((boundary) => ({
					id: boundary.id,
					leftSlotId: boundary.leftSlotId,
					rightSlotId: boundary.rightSlotId,
					targetSeconds: boundary.targetSeconds,
					policy: boundary.policy,
					maxDriftSeconds: boundary.maxDriftSeconds,
					fallback: boundary.fallback,
					earlyStartMaxDriftSeconds: boundary.earlyStartMaxDriftSeconds,
				})),
		}));
	}

	/** Return one authored daily schedule template. */
	async getScheduleTemplate(id: string): Promise<ScheduleTemplate | null> {
		const [template] = await this.db
			.select()
			.from(scheduleTemplates)
			.where(eq(scheduleTemplates.id, id));
		if (!template) {
			return null;
		}

		const [slots, boundaries] = await Promise.all([
			this.db
				.select()
				.from(scheduleSlots)
				.where(eq(scheduleSlots.templateId, id))
				.orderBy(asc(scheduleSlots.position)),
			this.db
				.select()
				.from(scheduleBoundaries)
				.where(eq(scheduleBoundaries.templateId, id))
				.orderBy(asc(scheduleBoundaries.position)),
		]);
		return {
			id: template.id,
			name: template.name,
			period: template.period,
			createdAt: template.createdAt,
			updatedAt: template.updatedAt,
			defaultFiller: template.defaultFiller ?? null,
			slots: slots.map((slot) => ({
				id: slot.id,
				startSeconds: slot.startSeconds,
				programId: slot.programId,
				stateScope: slot.stateScope,
				startEligibility: slot.startEligibility,
				filler: slot.filler,
			})),
			boundaries: boundaries.map((boundary) => ({
				id: boundary.id,
				leftSlotId: boundary.leftSlotId,
				rightSlotId: boundary.rightSlotId,
				targetSeconds: boundary.targetSeconds,
				policy: boundary.policy,
				maxDriftSeconds: boundary.maxDriftSeconds,
				fallback: boundary.fallback,
				earlyStartMaxDriftSeconds: boundary.earlyStartMaxDriftSeconds,
			})),
		};
	}

	/** Persist a new daily schedule template. */
	async createScheduleTemplate(input: ScheduleTemplateCreate): Promise<ScheduleTemplate> {
		validateTemplate(input, await this.listPrograms());
		await this.assertTemplateIdentitiesAvailable(null, input);
		const timestamp = currentTimestamp();
		const id = randomUUID();
		const nameKey = canonicalIdentityKey(input.name);
		const [nameConflict] = await this.db
			.select({ id: scheduleTemplates.id })
			.from(scheduleTemplates)
			.where(eq(scheduleTemplates.nameKey, nameKey))
			.limit(1);
		if (nameConflict) {
			throw new ResourceIdentityConflictError('template');
		}

		this.db.transaction((tx) => {
			tx.insert(scheduleTemplates)
				.values({
					id,
					name: input.name,
					nameKey,
					period: input.period,
					defaultFiller: input.defaultFiller,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();
			tx.insert(scheduleSlots)
				.values(
					[...input.slots]
						.sort((a, b) => a.startSeconds - b.startSeconds)
						.map((slot, position) => ({ ...slot, templateId: id, position })),
				)
				.run();
			tx.insert(scheduleBoundaries)
				.values(
					[...input.boundaries]
						.sort((a, b) => a.targetSeconds - b.targetSeconds)
						.map((boundary, position) => ({ ...boundary, templateId: id, position })),
				)
				.run();
		});
		return (await this.getScheduleTemplate(id))!;
	}

	/** Replace an existing daily schedule template and its slot boundaries. */
	async updateScheduleTemplate(
		id: string,
		input: ScheduleTemplateUpdate,
	): Promise<ScheduleTemplate | null> {
		const current = await this.getScheduleTemplate(id);
		if (!current) {
			return null;
		}

		const currentInput: ScheduleTemplateCreate = {
			name: current.name,
			period: current.period,
			defaultFiller: current.defaultFiller,
			slots: current.slots,
			boundaries: current.boundaries,
		};
		const updated = { ...currentInput, ...input } as ScheduleTemplateCreate;
		validateTemplate(updated, await this.listPrograms());
		await this.assertTemplateIdentitiesAvailable(id, updated);
		const nameKey = canonicalIdentityKey(updated.name);
		const [nameConflict] = await this.db
			.select({ id: scheduleTemplates.id })
			.from(scheduleTemplates)
			.where(eq(scheduleTemplates.nameKey, nameKey))
			.limit(1);
		if (nameConflict && nameConflict.id !== id) {
			throw new ResourceIdentityConflictError('template');
		}

		const updatedAt = currentTimestamp();
		this.db.transaction((tx) => {
			tx.update(scheduleTemplates)
				.set({
					name: updated.name,
					nameKey,
					period: updated.period,
					defaultFiller: updated.defaultFiller,
					updatedAt,
				})
				.where(eq(scheduleTemplates.id, id))
				.run();
			tx.delete(scheduleBoundaries).where(eq(scheduleBoundaries.templateId, id)).run();
			tx.delete(scheduleSlots).where(eq(scheduleSlots.templateId, id)).run();
			tx.insert(scheduleSlots)
				.values(
					[...updated.slots]
						.sort((a, b) => a.startSeconds - b.startSeconds)
						.map((slot, position) => ({ ...slot, templateId: id, position })),
				)
				.run();
			tx.insert(scheduleBoundaries)
				.values(
					[...updated.boundaries]
						.sort((a, b) => a.targetSeconds - b.targetSeconds)
						.map((boundary, position) => ({ ...boundary, templateId: id, position })),
				)
				.run();
		});
		return this.getScheduleTemplate(id);
	}

	/** Delete a template only when no channel base or conditional layer references it. */
	async deleteScheduleTemplate(id: string): Promise<boolean> {
		const [baseReference, layerReference] = await Promise.all([
			this.db
				.select({ channelId: channelSchedules.channelId })
				.from(channelSchedules)
				.where(eq(channelSchedules.defaultTemplateId, id))
				.limit(1),
			this.db
				.select({ channelId: channelScheduleLayers.channelId })
				.from(channelScheduleLayers)
				.where(eq(channelScheduleLayers.templateId, id))
				.limit(1),
		]);
		if (baseReference[0] || layerReference[0]) {
			throw new SchedulingValidationError('The template is assigned to a channel');
		}

		const result = await this.db.delete(scheduleTemplates).where(eq(scheduleTemplates.id, id));
		return result.changes > 0;
	}

	/** Return the layered schedule assigned to a channel. */
	async getChannelSchedule(channelId: string): Promise<ChannelSchedule | null> {
		const [[row], layers] = await Promise.all([
			this.db.select().from(channelSchedules).where(eq(channelSchedules.channelId, channelId)),
			this.db
				.select()
				.from(channelScheduleLayers)
				.where(eq(channelScheduleLayers.channelId, channelId))
				.orderBy(asc(channelScheduleLayers.position)),
		]);
		return row
			? {
				...channelScheduleConfigSchema.parse({
					...row.config,
					defaultTemplateId: row.defaultTemplateId,
					layers: layers.map((layer) => ({
						id: layer.id,
						templateId: layer.templateId,
						predicate: layer.predicate,
						entryBoundary: layer.entryBoundary,
						exitBoundary: layer.exitBoundary,
					})),
				}),
				channelId: row.channelId,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			}
			: null;
	}

	/** List every configured channel schedule. */
	async listChannelSchedules(): Promise<ChannelSchedule[]> {
		const [rows, layers] = await Promise.all([
			this.db.select().from(channelSchedules).orderBy(asc(channelSchedules.channelId)),
			this.db
				.select()
				.from(channelScheduleLayers)
				.orderBy(asc(channelScheduleLayers.channelId), asc(channelScheduleLayers.position)),
		]);
		const layersByChannel = new Map<string, typeof layers>();
		for (const layer of layers) {
			const channelLayers = layersByChannel.get(layer.channelId) ?? [];
			channelLayers.push(layer);
			layersByChannel.set(layer.channelId, channelLayers);
		}
		return rows.map((row) => ({
			...channelScheduleConfigSchema.parse({
				...row.config,
				defaultTemplateId: row.defaultTemplateId,
				layers: (layersByChannel.get(row.channelId) ?? []).map((layer) => ({
					id: layer.id,
					templateId: layer.templateId,
					predicate: layer.predicate,
					entryBoundary: layer.entryBoundary,
					exitBoundary: layer.exitBoundary,
				})),
			}),
			channelId: row.channelId,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}));
	}

	/** Persist a channel's base and conditional template stack. */
	async setChannelSchedule(
		channelId: string,
		config: ChannelScheduleConfig,
	): Promise<ChannelSchedule | null> {
		const [channel] = await this.db
			.select({ id: channels.id })
			.from(channels)
			.where(eq(channels.id, channelId));
		if (!channel) {
			return null;
		}

		const [templateRows, programRows] = await Promise.all([
			this.db.select({ id: scheduleTemplates.id }).from(scheduleTemplates),
			this.db.select({ id: schedulingPrograms.id }).from(schedulingPrograms),
		]);
		validateChannelSchedule(
			config,
			new Set(templateRows.map((template) => template.id)),
			new Set(programRows.map((program) => program.id)),
		);
		await this.assertLayerIdentitiesAvailable(channelId, config.layers.map((layer) => layer.id));
		const current = await this.getChannelSchedule(channelId);
		const timestamp = currentTimestamp();
		this.db.transaction((tx) => {
			tx.insert(channelSchedules)
				.values({
					channelId,
					defaultTemplateId: config.defaultTemplateId,
					config,
					createdAt: current?.createdAt ?? timestamp,
					updatedAt: timestamp,
				})
				.onConflictDoUpdate({
					target: channelSchedules.channelId,
					set: { defaultTemplateId: config.defaultTemplateId, config, updatedAt: timestamp },
				})
				.run();
			tx.delete(channelScheduleLayers).where(eq(channelScheduleLayers.channelId, channelId)).run();
			if (config.layers.length > 0) {
				tx.insert(channelScheduleLayers)
					.values(
						config.layers.map((layer, position) => ({
							...layer,
							channelId,
							position,
						})),
					)
					.run();
			}
		});
		return this.getChannelSchedule(channelId);
	}

	/** Reject slot or boundary IDs already owned by another template. */
	private async assertTemplateIdentitiesAvailable(
		templateId: string | null,
		input: ScheduleTemplateCreate,
	): Promise<void> {
		const slotIds = input.slots.map((slot) => slot.id);
		const boundaryIds = input.boundaries.map((boundary) => boundary.id);
		const [slots, boundaries] = await Promise.all([
			slotIds.length > 0
				? this.db
					.select({ ownerId: scheduleSlots.templateId })
					.from(scheduleSlots)
					.where(inArray(scheduleSlots.id, slotIds))
				: Promise.resolve([]),
			boundaryIds.length > 0
				? this.db
					.select({ ownerId: scheduleBoundaries.templateId })
					.from(scheduleBoundaries)
					.where(inArray(scheduleBoundaries.id, boundaryIds))
				: Promise.resolve([]),
		]);
		if (slots.some((slot) => slot.ownerId !== templateId)) {
			throw new SchedulingIdentityConflictError('slot');
		}

		if (boundaries.some((boundary) => boundary.ownerId !== templateId)) {
			throw new SchedulingIdentityConflictError('boundary');
		}
	}

	/** Reject layer IDs already owned by another channel schedule. */
	private async assertLayerIdentitiesAvailable(channelId: string, layerIds: string[]): Promise<void> {
		if (layerIds.length === 0) {
			return;
		}

		const rows = await this.db
			.select({ ownerId: channelScheduleLayers.channelId })
			.from(channelScheduleLayers)
			.where(inArray(channelScheduleLayers.id, layerIds));
		if (rows.some((layer) => layer.ownerId !== channelId)) {
			throw new SchedulingIdentityConflictError('layer');
		}
	}

	/** Delete a channel's template stack, committed timeline, and persistent playback cursors. */
	async deleteChannelSchedule(channelId: string): Promise<boolean> {
		return this.db.transaction((tx) => {
			tx.delete(materializedTimelineSegments)
				.where(eq(materializedTimelineSegments.channelId, channelId))
				.run();
			tx.delete(timelineMaterializations)
				.where(eq(timelineMaterializations.channelId, channelId))
				.run();
			tx.delete(selectionStates).where(eq(selectionStates.channelId, channelId)).run();
			return (
				tx.delete(channelSchedules).where(eq(channelSchedules.channelId, channelId)).run().changes
				> 0
			);
		});
	}

	/** Legacy base-assignment helper; layered schedules must be removed through the channel API. */
	async setTemplateAssignments(
		templateId: string,
		channelIds: string[],
	): Promise<ChannelSchedule[]> {
		const [template, channelRows, currentSchedules] = await Promise.all([
			this.getScheduleTemplate(templateId),
			this.db.select({ id: channels.id }).from(channels),
			this.listChannelSchedules(),
		]);
		if (!template) {
			throw new SchedulingValidationError('The schedule template does not exist');
		}

		const knownChannelIds = new Set(channelRows.map((channel) => channel.id));
		const selectedIds = new Set(channelIds);
		for (const channelId of selectedIds) {
			if (!knownChannelIds.has(channelId)) {
				throw new SchedulingValidationError(`Channel ${channelId} does not exist`);
			}
		}
		const currentByChannel = new Map(
			currentSchedules.map((schedule) => [schedule.channelId, schedule]),
		);
		const removedBase = currentSchedules.find(
			(schedule) =>
				schedule.defaultTemplateId === templateId && !selectedIds.has(schedule.channelId),
		);
		if (removedBase) {
			throw new SchedulingValidationError(
				'A base template cannot be unassigned without choosing its replacement on the channel schedule',
			);
		}

		const timestamp = currentTimestamp();
		this.db.transaction((tx) => {
			for (const channelId of selectedIds) {
				const current = currentByChannel.get(channelId);
				const config: ChannelScheduleConfig = {
					defaultTemplateId: templateId,
					layers: current?.layers ?? [],
					defaultFiller: current?.defaultFiller ?? null,
				};
				tx.insert(channelSchedules)
					.values({
						channelId,
						defaultTemplateId: templateId,
						config,
						createdAt: current?.createdAt ?? timestamp,
						updatedAt: timestamp,
					})
					.onConflictDoUpdate({
						target: channelSchedules.channelId,
						set: { defaultTemplateId: templateId, config, updatedAt: timestamp },
					})
					.run();
			}
		});
		return this.listChannelSchedules();
	}

}
