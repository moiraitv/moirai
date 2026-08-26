import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type {
	ChannelSchedule,
	ChannelScheduleConfig,
	ProgramCreate,
	ProgramUpdate,
	ScheduleTemplate,
	ScheduleTemplateCreate,
	ScheduleTemplateUpdate,
	SchedulingProgram,
} from '@moirai/shared';
import {
	canonicalIdentityKey,
	channelScheduleConfigSchema,
	programConfigSchema,
} from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import {
	channels,
	channelScheduleLayers,
	channelSchedules,
	materializedTimelineSegments,
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
import { currentTimestamp } from '../time.js';

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
		const timestamp = currentTimestamp();
		const program: SchedulingProgram = {
			id: randomUUID(),
			...input,
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

	/** Replace a program configuration while preserving its identity. */
	async updateProgram(id: string, input: ProgramUpdate): Promise<SchedulingProgram | null> {
		const current = await this.getProgram(id);
		if (!current) {
			return null;
		}

		const updated: SchedulingProgram = {
			...current,
			name: input.name ?? current.name,
			config: input.config ?? current.config,
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
