import { sql, type SQL } from 'drizzle-orm';
import type { ResourceUsage, ResourceUsageKind } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';

/** Restrict dynamic table identifiers to the supported reusable resource domains. */
const tables: Record<Exclude<ResourceUsageKind, 'media'>, string> = {
	program: 'scheduling_programs', template: 'schedule_templates',
	'encoding-profile': 'encoding_profiles', 'credit-template': 'credit_templates',
	'guide-template': 'guide_templates', 'mid-roll-preset': 'filler_presets', 'filler-preset': 'filler_presets',
};

/** Find stage assignments in each owner without expanding scheduling catalogs. */
function fillerReferences(id: string, key: 'programId' | 'presetId'): SQL {
	return sql`SELECT 'template' AS kind, t.id, t.name, 'Default filler' AS role FROM schedule_templates t,
		json_tree(json_array(json(t.default_filler), json(t.default_mid_roll), json(t.default_pre_roll), json(t.default_post_roll))) j
		WHERE j.key = ${key} AND j.value = ${id}
		UNION ALL SELECT 'template', t.id, t.name, 'Slot filler' FROM schedule_slots s JOIN schedule_templates t ON t.id = s.template_id,
		json_tree(json_array(json(s.filler), json(s.mid_roll), json(s.pre_roll), json(s.post_roll))) j WHERE j.key = ${key} AND j.value = ${id}
		UNION ALL SELECT 'channel-schedule', c.id, c.name, 'Schedule filler' FROM channel_schedules s JOIN channels c ON c.id = s.channel_id,
		json_tree(json_array(json_extract(s.config, '$.defaultFiller'), json_extract(s.config, '$.defaultTailFiller'), json_extract(s.config, '$.defaultMidRoll'), json_extract(s.config, '$.defaultPreRoll'), json_extract(s.config, '$.defaultPostRoll'))) j
		WHERE j.key = ${key} AND j.value = ${id}`;
}

/** Select only direct authored references, retaining repeated occurrences for their owner count. */
function references(kind: Exclude<ResourceUsageKind, 'media'>, id: string): SQL {
	if (kind === 'program') {
		return sql`
			SELECT 'program' AS kind, p.id, p.name, 'Sequence entry' AS role
			FROM scheduling_programs p, json_each(p.config, '$.entries') e
			WHERE json_extract(p.config, '$.type') = 'sequence' AND json_extract(e.value, '$.programId') = ${id}
			UNION ALL
			SELECT 'program', p.id, p.name, 'Similarity source' FROM scheduling_programs p
			WHERE json_extract(p.config, '$.type') = 'similarity' AND json_extract(p.config, '$.sourceProgramId') = ${id}
			UNION ALL SELECT 'template', t.id, t.name, 'Slot program'
			FROM schedule_slots s JOIN schedule_templates t ON t.id = s.template_id WHERE s.program_id = ${id}
			UNION ALL ${fillerReferences(id, 'programId')}
			UNION ALL SELECT 'channel-schedule', c.id, c.name, 'Base program'
			FROM channel_schedules s JOIN channels c ON c.id = s.channel_id
			WHERE s.default_program_id = ${id}
			UNION ALL SELECT 'channel-schedule', c.id, c.name, 'Conditional program'
			FROM channel_schedule_layers l JOIN channels c ON c.id = l.channel_id
			WHERE l.program_id = ${id}`;
	}
	if (kind === 'mid-roll-preset' || kind === 'filler-preset') {
		return fillerReferences(id, 'presetId');
	}
	if (kind === 'template') {
		return sql`
			SELECT 'channel-schedule' AS kind, c.id, c.name, 'Base template' AS role
			FROM channel_schedules s JOIN channels c ON c.id = s.channel_id WHERE s.default_template_id = ${id}
			UNION ALL SELECT 'channel-schedule', c.id, c.name, 'Conditional template'
			FROM channel_schedule_layers l JOIN channels c ON c.id = l.channel_id WHERE l.template_id = ${id}`;
	}
	if (kind === 'encoding-profile') {
		return sql`SELECT 'channel' AS kind, id, name, 'Encoding profile' AS role FROM channels
			WHERE json_extract(config, '$.encodingProfileId') = ${id}`;
	}
	if (kind === 'guide-template') {
		return sql`
			SELECT 'channel' AS kind, id, name, 'Guide template' AS role FROM channels
			WHERE json_extract(config, '$.guideTemplateId') = ${id}
			UNION ALL SELECT 'channel', id, name, 'Default'
			FROM channels
			WHERE json_extract(config, '$.guideTemplateId') IS NULL
			AND EXISTS (SELECT 1 FROM guide_templates WHERE id = ${id} AND is_default = 1)`;
	}
	return sql`
		SELECT 'channel' AS kind, id, name, 'Music video credits' AS role FROM channels
		WHERE json_extract(config, '$.subtitlePreferences.creditsTemplateId') = ${id}
		UNION ALL SELECT 'program', id, name, 'Music video credits' FROM scheduling_programs
		WHERE json_extract(config, '$.subtitlePreferences.creditsTemplateId') = ${id}`;
}

/** Read a bounded usage page in three queries without loading catalogs or expanding dependencies. */
export function resourceUsage(db: MoiraiDatabase, kind: Exclude<ResourceUsageKind, 'media'>, id: string, page: number, pageSize: number): ResourceUsage | null {
	return db.transaction(tx => {
		if (!tx.get(sql`SELECT id FROM ${sql.identifier(tables[kind])} WHERE id = ${id}`)) {
			return null;
		}
		const owners = sql`WITH refs AS (${references(kind, id)}), owners AS (
			SELECT kind, id, name, group_concat(DISTINCT role) AS roles, count(*) AS referenceCount
			FROM refs GROUP BY kind, id, name)`;
		const total = tx.get<{ total: number }>(sql`${owners} SELECT count(*) AS total FROM owners`)!.total;
		const rows = tx.all<{ kind: ResourceUsage['items'][number]['kind']; id: string; name: string; roles: string; referenceCount: number }>(
			sql`${owners} SELECT * FROM owners ORDER BY name COLLATE NOCASE, kind, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
		);
		return { total, items: rows.map(row => ({ ...row, roles: row.roles.split(',').sort() })) };
	});
}
