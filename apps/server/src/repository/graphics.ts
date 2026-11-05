import { instantMilliseconds } from '../db/instant.js';
import { validateGraphicsTemplate } from '../graphics/render.js';
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { graphicsAssignmentSchema, type GraphicsAssignment, type GraphicsAsset, type GraphicsDocument, type GraphicsPreset, type TimelineSegment } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { channels, graphicsAssets, graphicsPresets } from '../db/schema.js';
import { parseGraphics } from '../graphics/document.js';
import { exampleGraphicsAssets, graphicsExamples } from '../graphics/examples.js';

/** Canonical comparison key for saved and restored graphics preset names. */
export function graphicsNameKey(name: string): string {
	return name.normalize('NFKC').toLowerCase();
}

/** Reserve example identities, allowing only existing presets to keep the two overlapping names. */
export function reservedGraphicsPreset(id: string, nameKey: string, { allowLegacyName = false } = {}): boolean {
	return graphicsExamples.some(example => example.id === id
		|| (graphicsNameKey(example.name) === nameKey
			&& !(allowLegacyName && (example.name === 'Live Clock' || example.name === 'Upcoming Ticker'))));
}

/** Parse a preset and reject invalid Liquid before it can reach playout. */
export function validateGraphicsDocument(source: string): GraphicsDocument {
	const document = parseGraphics(source);
	for (const layer of document.layers) {
		if (layer.kind === 'text') {
			validateGraphicsTemplate(layer.text);
		}
	}
	return document;
}

/** An expected graphics validation or reference failure safe for an administrator to see. */
export class GraphicsError extends Error {
	readonly expose = true;

	constructor(readonly statusCode: 400 | 404 | 409, message: string) {
		super(message);
	}
}

/** Return the required kind of each referenced managed asset. */
export function graphicsReferences(document: GraphicsDocument): Map<string, 'media' | 'font'> {
	const references = new Map<string, 'media' | 'font'>();
	for (const layer of document.layers) {
		if (layer.kind === 'media') {
			if (references.get(layer.assetId) === 'font') {
				throw new GraphicsError(400, 'An asset cannot be used as both media and a font');
			}
			references.set(layer.assetId, 'media');
		}
		else if (layer.kind === 'text') {
			for (const style of [layer.style, ...Object.values(layer.styles ?? {})]) {
				if (style.fontId) {
					if (references.get(style.fontId) === 'media') {
						throw new GraphicsError(400, 'An asset cannot be used as both media and a font');
					}
					references.set(style.fontId, 'font');
				}
			}
		}
	}
	return references;
}

/** Authored assignments indexed by scheduling entity and stable identity. */
export type GraphicsAssignments = Map<string, GraphicsAssignment>;

/** Validated preset documents and the managed assets available to them. */
export type PreparedGraphicsPresets = Map<string, { document: GraphicsDocument; assets: Map<string, GraphicsAsset> }>;

/** Read and write presets and managed asset metadata; bundled examples are stable virtual seeds. */
export class GraphicsRepository {
	constructor(private readonly db: Pick<MoiraiDatabase, 'select' | 'insert' | 'delete' | 'all' | 'transaction'>) {}

	/** List protected examples first, followed by custom presets in name order. */
	list(): GraphicsPreset[] {
		return [...graphicsExamples, ...this.db.select().from(graphicsPresets).orderBy(asc(graphicsPresets.nameKey)).all()
			.map(({ id, name, yaml }) => ({ id, name, yaml, protected: false }))];
	}

	/** Resolve one saved preset without scanning the preset collection. */
	get(id: string): GraphicsPreset | undefined {
		const example = graphicsExamples.find(preset => preset.id === id);
		const row = example ? undefined : this.db.select().from(graphicsPresets).where(eq(graphicsPresets.id, id)).get();
		return example ?? (row && { id: row.id, name: row.name, yaml: row.yaml, protected: false });
	}

	/** Read the distinct presets needed for a playout window in one query. */
	getMany(ids: ReadonlySet<string>): Map<string, GraphicsPreset> {
		const presets = new Map(graphicsExamples.filter(preset => ids.has(preset.id)).map(preset => [preset.id, preset]));
		const managed = [...ids].filter(id => !presets.has(id));
		if (managed.length) {
			for (const { id, name, yaml } of this.db.select().from(graphicsPresets)
				.where(sql`${graphicsPresets.id} IN (SELECT value FROM json_each(${JSON.stringify(managed)}))`).all()) {
				presets.set(id, { id, name, yaml, protected: false });
			}
		}
		return presets;
	}

	/** Read managed asset metadata in a single query. */
	assets(): GraphicsAsset[] {
		return [...exampleGraphicsAssets, ...this.db.select().from(graphicsAssets).orderBy(asc(graphicsAssets.name)).all()
			.map(row => ({ ...row, protected: false }))];
	}

	/** Resolve one managed file without loading the asset collection. */
	asset(id: string): GraphicsAsset | undefined {
		const example = exampleGraphicsAssets.find(asset => asset.id === id);
		const row = example ? undefined : this.db.select().from(graphicsAssets).where(eq(graphicsAssets.id, id)).get();
		return example ?? (row && { ...row, protected: false });
	}

	/** Save asset metadata after its immutable bytes have been written. */
	addAsset(asset: GraphicsAsset): void {
		const { id, name, kind, format } = asset;
		this.db.insert(graphicsAssets).values({ id, name, kind, format }).run();
	}

	/** Fetch only the asset metadata referenced by this preparation window. */
	private assetsById(ids: ReadonlySet<string>): Map<string, GraphicsAsset> {
		const assets = new Map(exampleGraphicsAssets.filter(asset => ids.has(asset.id)).map(asset => [asset.id, asset]));
		const required = [...ids].filter(id => !assets.has(id));
		if (required.length) {
			for (const row of this.db.select().from(graphicsAssets)
				.where(sql`${graphicsAssets.id} IN (SELECT value FROM json_each(${JSON.stringify(required)}))`).all()) {
				assets.set(row.id, { ...row, protected: false });
			}
		}
		return assets;
	}

	/** Check references against one batch of asset metadata. */
	validateAssets(document: GraphicsDocument): Map<string, GraphicsAsset> {
		const references = graphicsReferences(document);
		const assets = this.assetsById(new Set(references.keys()));
		for (const [id, kind] of references) {
			const asset = assets.get(id);
			if (!asset || (asset.kind === 'font') !== (kind === 'font')) {
				throw new GraphicsError(400, `Missing or incompatible graphics asset ${id}`);
			}
		}
		return assets;
	}

	/** Batch preset and asset lookups while keeping invalid assignments local to the affected preset. */
	preparePresets(ids: ReadonlySet<string>): PreparedGraphicsPresets {
		const drafts = new Map<string, { document: GraphicsDocument; references: ReturnType<typeof graphicsReferences> }>();
		const assetIds = new Set<string>();
		for (const [id, preset] of this.getMany(ids)) {
			try {
				const document = parseGraphics(preset.yaml);
				const references = graphicsReferences(document);
				drafts.set(id, { document, references });
				for (const assetId of references.keys()) {
					assetIds.add(assetId);
				}
			}
			catch {
				// An absent result lets publication skip this preset and report a warning.
			}
		}
		const assets = this.assetsById(assetIds);
		const prepared: PreparedGraphicsPresets = new Map();
		for (const [id, { document, references }] of drafts) {
			const validated = new Map<string, GraphicsAsset>();
			for (const [assetId, kind] of references) {
				const asset = assets.get(assetId);
				if (asset && (asset.kind === 'font') === (kind === 'font')) {
					validated.set(assetId, asset);
				}
			}
			if (validated.size === references.size) {
				prepared.set(id, { document, assets: validated });
			}
		}
		return prepared;
	}

	/** Save a validated preset, retaining its exact YAML source. */
	save(draft: Pick<GraphicsPreset, 'name' | 'yaml'>, id?: string): GraphicsPreset {
		const presetId = id ?? randomUUID();
		const nameKey = graphicsNameKey(draft.name);
		let document: GraphicsDocument;
		try {
			document = validateGraphicsDocument(draft.yaml);
		}
		catch (error) {
			throw new GraphicsError(400, (error as Error).message.slice(0, 512));
		}
		this.validateAssets(document);
		const existing = id ? this.get(id) : undefined;
		if (id && !existing) {
			throw new GraphicsError(404, 'Graphics preset does not exist');
		}
		if (reservedGraphicsPreset(presetId, nameKey, { allowLegacyName: existing?.name === draft.name })) {
			throw new GraphicsError(409, 'This name or preset is reserved for a protected example');
		}
		const conflict = this.db.select({ id: graphicsPresets.id }).from(graphicsPresets).where(eq(graphicsPresets.nameKey, nameKey)).get();
		if (conflict && conflict.id !== presetId) {
			throw new GraphicsError(409, 'A graphics preset with this name already exists');
		}
		this.db.insert(graphicsPresets).values({ id: presetId, ...draft, nameKey }).onConflictDoUpdate({
			target: graphicsPresets.id, set: { ...draft, nameKey },
		}).run();
		return { id: presetId, ...draft, protected: false };
	}

	/** Batch overrides for a committed window, or read all assignments for administration. */
	assignments(window?: { channelId: string; segments: readonly TimelineSegment[] }): GraphicsAssignments {
		const segments = window?.segments.filter(segment => segment.role === 'primary'
			|| (segment.role === 'filler' && (segment.airing || segment.fillerPresetId)));
		const templates = segments?.map(segment => segment.templateId);
		const slots = segments?.map(segment => segment.slotId);
		const programs = segments?.flatMap(segment => segment.programAncestry?.length
			? segment.programAncestry : segment.programId ? [segment.programId] : []);
		const filler = segments?.flatMap(segment => segment.fillerPresetId ? [segment.fillerPresetId] : []);
		const matching = (ids: string[] | undefined) => ids
			? sql`AND id IN (SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))` : sql``;
		const schedule = window ? sql`AND channel_id = ${window.channelId}` : sql``;
		const rows = this.db.all<{ scope: string; id: string; assignment: string }>(sql`
			SELECT 'schedule' AS scope, channel_id AS id, json_extract(config, '$.graphicsAssignment') AS assignment
			FROM channel_schedules WHERE assignment IS NOT NULL ${schedule}
			UNION ALL SELECT 'template', id, graphics_assignment FROM schedule_templates WHERE graphics_assignment IS NOT NULL ${matching(templates)}
			UNION ALL SELECT 'slot', id, graphics_assignment FROM schedule_slots WHERE graphics_assignment IS NOT NULL ${matching(slots)}
			UNION ALL SELECT 'program', id, json_extract(config, '$.graphicsAssignment') AS assignment FROM scheduling_programs WHERE assignment IS NOT NULL ${matching(programs)}
			UNION ALL SELECT 'filler', id, json_extract(config, '$.graphicsAssignment') AS assignment FROM filler_presets WHERE assignment IS NOT NULL ${matching(filler)}`);
		return new Map(rows.map(row => [`${row.scope}:${row.id}`, graphicsAssignmentSchema.parse(JSON.parse(row.assignment))]));
	}

	/** Locate channels whose current or future committed items use a scheduling scope. */
	channelsUsingScope(scope: string, id: string): string[] {
		if (scope === 'schedule') {
			return [id];
		}
		const predicate = scope === 'template' ? sql`template_id = ${id}`
			: scope === 'slot' ? sql`slot_id = ${id}`
				: scope === 'filler' ? sql`filler_preset_id = ${id}`
					: sql`(program_id = ${id} OR EXISTS (SELECT 1 FROM json_each(program_ancestry) WHERE value = ${id}))`;
		return this.db.all<{ id: string }>(sql`
			SELECT DISTINCT channel_id AS id FROM materialized_timeline_segments
			WHERE role != 'dead-air' AND ${instantMilliseconds(sql`finishes_at`)} > ${Date.now()} AND ${predicate}`).map(row => row.id);
	}

	/** Reject assignments to missing presets, including during backup validation. */
	validateAssignments(assignments: Iterable<GraphicsAssignment | undefined>): void {
		const ids = new Set([...assignments].flatMap(assignment => assignment && 'presetId' in assignment ? [assignment.presetId] : []));
		if (this.getMany(ids).size !== ids.size) {
			throw new GraphicsError(400, 'Selected graphics preset does not exist');
		}
	}

	/** Remove an unassigned custom preset. */
	delete(id: string): void {
		const preset = this.get(id);
		if (!preset) {
			throw new GraphicsError(404, 'Graphics preset does not exist');
		}
		this.db.transaction(tx => {
			const assigned = tx.select({ id: channels.id }).from(channels)
				.where(sql`json_extract(${channels.config}, '$.graphicsPresetId') = ${id}`).get();
			if (assigned || preset.protected || [...new GraphicsRepository(tx).assignments().values()].some(assignment => 'presetId' in assignment && assignment.presetId === id)) {
				throw new GraphicsError(409, 'Assigned and protected graphics presets cannot be deleted');
			}
			tx.delete(graphicsPresets).where(eq(graphicsPresets.id, id)).run();
		});
	}

	/** Retire an unused asset while leaving published playout files readable. */
	deleteAsset(id: string): GraphicsAsset {
		const asset = this.asset(id);
		if (!asset) {
			throw new GraphicsError(404, 'Graphics asset does not exist');
		}
		if (asset.protected
			|| this.list().some(preset => graphicsReferences(parseGraphics(preset.yaml)).has(id))) {
			throw new GraphicsError(409, 'Referenced and protected graphics assets cannot be deleted');
		}
		this.db.delete(graphicsAssets).where(eq(graphicsAssets.id, id)).run();
		return asset;
	}
}
