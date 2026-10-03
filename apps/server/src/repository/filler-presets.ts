import { referencedFillerAssignments } from '../scheduling/mid-roll-presets.js';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { BUILTIN_MID_ROLL_PRESETS, BUILTIN_FILLER_PRESETS, canonicalIdentityKey, type AnyFillerPreset, type AnyFillerPresetCreate, type FillerKind } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { fillerPresets } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/** Preset conflicts and invalid references safe to display to administrators. */
export class FillerPresetError extends Error {
	constructor(message: string, readonly statusCode = 409) {
		super(message);
	}
}

/** Present built-in behavior from the maintained constants and custom behavior from storage. */
function mappedPreset(row: typeof fillerPresets.$inferSelect): AnyFillerPreset {
	const builtin = row.isBuiltin ? [...BUILTIN_FILLER_PRESETS, ...BUILTIN_MID_ROLL_PRESETS.map(preset => ({ ...preset, kind: 'mid-roll' as const }))].find(preset => preset.id === row.id) : undefined;
	return { ...row.config, ...builtin, id: row.id, isBuiltin: row.isBuiltin, createdAt: row.createdAt, updatedAt: row.updatedAt } as AnyFillerPreset;
}

/** Compare scheduling behavior independently of names, descriptions, and timestamps. */
function presetBehavior(input: AnyFillerPresetCreate): object {
	return input.kind === 'mid-roll' ? { kind: input.kind, budget: input.budget, predicate: input.predicate, fallbackIntervalSeconds: input.fallbackIntervalSeconds }
		: { kind: input.kind, budget: input.budget };
}

/**
 * Own named break behavior and its authored references. Changes become scheduling inputs;
 * existing committed airings remain under the materializer's application boundaries.
 */
export class FillerPresetRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List protected examples before custom presets in name order. */
	async list(kind?: FillerKind): Promise<AnyFillerPreset[]> {
		return this.db.select().from(fillerPresets).where(kind ? eq(fillerPresets.kind, kind) : undefined).orderBy(asc(fillerPresets.nameKey)).all().map(mappedPreset)
			.sort((left, right) => Number(right.isBuiltin) - Number(left.isBuiltin) || left.name.localeCompare(right.name));
	}

	/** Load only the referenced behavior in one query, and reject stale assignments. */
	settings(ids: string[]): Record<string, AnyFillerPreset> {
		if (ids.length === 0) {
			return {};
		}
		const unique = [...new Set(ids)];
		const rows = this.db.select().from(fillerPresets).where(inArray(fillerPresets.id, unique)).all();
		if (rows.length !== unique.length) {
			throw new FillerPresetError('Selected Filler preset does not exist', 400);
		}
		return Object.fromEntries(rows.map(row => {
			return [row.id, mappedPreset(row)];
		}));
	}

	/** Validate existence and stage in one bounded assignment query. */
	validateAssignments(...input: Parameters<typeof referencedFillerAssignments>): void {
		const references = referencedFillerAssignments(...input);
		const presets = this.settings([...references.keys()]);
		for (const [id, kinds] of references) {
			if (kinds.size !== 1 || !kinds.has(presets[id]!.kind)) {
				throw new FillerPresetError('Selected filler preset does not match its assignment type', 400);
			}
		}
	}

	/** Save custom settings; name and description changes do not change scheduling behavior. */
	async save(input: AnyFillerPresetCreate, id?: string): Promise<{ preset: AnyFillerPreset; behaviorChanged: boolean }> {
		return this.db.transaction(tx => {
			const current = id ? tx.select().from(fillerPresets).where(eq(fillerPresets.id, id)).get() : undefined;
			if (id && !current) {
				throw new FillerPresetError('Filler preset not found', 404);
			}
			if (current && current.kind !== input.kind) {
				throw new FillerPresetError('A preset’s filler type cannot be changed');
			}
			if (current?.isBuiltin) {
				throw new FillerPresetError('Built-in Filler presets cannot be edited; duplicate one to customize it');
			}
			const nameKey = canonicalIdentityKey(input.name);
			const conflict = tx.select().from(fillerPresets).where(and(eq(fillerPresets.nameKey, nameKey), eq(fillerPresets.kind, input.kind))).get();
			if (conflict && conflict.id !== id) {
				throw new FillerPresetError('A Filler preset with that name already exists');
			}

			const timestamp = currentTimestamp();
			const row = { kind: input.kind, id: id ?? randomUUID(), name: input.name, nameKey, config: input,
				createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp, isBuiltin: false };
			if (id) {
				tx.update(fillerPresets).set(row).where(eq(fillerPresets.id, id)).run();
			}
			else {
				tx.insert(fillerPresets).values(row).run();
			}
			return { preset: mappedPreset(row), behaviorChanged: Boolean(current && JSON.stringify(presetBehavior(current.config)) !== JSON.stringify(presetBehavior(input))) };
		});
	}

	/** Delete only custom presets without any channel, template, or slot references. */
	async delete(id: string, kind?: FillerKind): Promise<void> {
		this.db.transaction(tx => {
			const current = tx.select().from(fillerPresets).where(eq(fillerPresets.id, id)).get();
			if (!current || (kind && current.kind !== kind)) {
				throw new FillerPresetError('Filler preset not found', 404);
			}
			if (current.isBuiltin) {
				throw new FillerPresetError('Built-in Filler presets cannot be deleted');
			}
			const linked = tx.get(sql`SELECT 1 FROM schedule_templates t, json_tree(json_array(json(t.default_filler), json(t.default_mid_roll), json(t.default_pre_roll), json(t.default_post_roll))) j
				WHERE j.key = 'presetId' AND j.value = ${id}
				UNION ALL SELECT 1 FROM schedule_slots s, json_tree(json_array(json(s.filler), json(s.mid_roll), json(s.pre_roll), json(s.post_roll))) j WHERE j.key = 'presetId' AND j.value = ${id}
				UNION ALL SELECT 1 FROM channel_schedules s, json_tree(s.config) j WHERE j.key = 'presetId' AND j.value = ${id} LIMIT 1`);
			if (linked) {
				throw new FillerPresetError('Filler preset is in use; choose another Filler preset before deleting it');
			}
			tx.delete(fillerPresets).where(eq(fillerPresets.id, id)).run();
		});
	}
}
