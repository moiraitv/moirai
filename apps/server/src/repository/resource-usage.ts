import { sql, type SQL } from 'drizzle-orm';
import type { ResourceUsage, ResourceUsageKind } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';

/** Restrict dynamic table identifiers to the supported reusable resource domains. */
const tables: Record<Exclude<ResourceUsageKind, 'media'>, string> = {
	program: 'scheduling_programs', template: 'schedule_templates',
	'encoding-profile': 'encoding_profiles', 'credit-template': 'credit_templates',
};

/** Select only direct authored references, retaining repeated occurrences for their owner count. */
function references(kind: Exclude<ResourceUsageKind, 'media'>, id: string): SQL {
	if (kind === 'program') {
		return sql`
			SELECT 'program' AS kind, p.id, p.name, 'Sequence entry' AS role
			FROM scheduling_programs p, json_each(p.config, '$.entries') e
			WHERE json_extract(p.config, '$.type') = 'sequence' AND json_extract(e.value, '$.programId') = ${id}
			UNION ALL SELECT 'template', t.id, t.name, 'Slot program'
			FROM schedule_slots s JOIN schedule_templates t ON t.id = s.template_id WHERE s.program_id = ${id}
			UNION ALL SELECT 'template', t.id, t.name, 'Slot filler'
			FROM schedule_slots s JOIN schedule_templates t ON t.id = s.template_id
			WHERE json_extract(s.filler, '$.mode') = 'configured' AND json_extract(s.filler, '$.config.programId') = ${id}
			UNION ALL SELECT 'template', id, name, 'Default filler' FROM schedule_templates
			WHERE json_extract(default_filler, '$.programId') = ${id}
			UNION ALL SELECT 'channel-schedule', c.id, c.name, 'Schedule filler'
			FROM channel_schedules s JOIN channels c ON c.id = s.channel_id
			WHERE json_extract(s.config, '$.defaultFiller.programId') = ${id}`;
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
