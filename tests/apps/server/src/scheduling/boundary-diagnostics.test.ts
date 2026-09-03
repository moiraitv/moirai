import { describe, expect, it } from 'vitest';
import {
	channelScheduleConfigSchema,
	scheduleTemplateCreateSchema,
	SECONDS_PER_SCHEDULING_DAY,
	type ScheduleTemplate,
	type SchedulableMedia,
	type SchedulingProgram,
} from '@moirai/shared';
import { generateTimeline, type GenerateTimelineInput } from '@server/scheduling/engine.js';
import { deadAirDiagnostics } from '@web/schedule-diagnostics';
import { deadAirAction } from '@web/schedule-diagnostic-actions';

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const timestamps = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const origins = ['template', 'layer-entry', 'layer-exit'] as const;

function fixture(origin: typeof origins[number], nested = false): GenerateTimelineInput {
	const outgoing: SchedulingProgram = {
		id: uuid(10), name: 'Outgoing', ...timestamps,
		config: {
			type: 'content',
			source: { type: 'collection', libraryId: uuid(900), itemIds: [uuid(1), uuid(2)], sort: { type: 'date-added', direction: 'asc' } },
			strategy: { type: 'sequential' },
		},
	};
	const incoming: SchedulingProgram = {
		id: uuid(11), name: 'Incoming', ...timestamps,
		config: { type: 'content', source: { type: 'item', itemId: uuid(3) }, strategy: { type: 'sequential' } },
	};
	const sequence: SchedulingProgram = {
		id: uuid(12), name: 'Sequence', ...timestamps,
		config: {
			type: 'sequence', repeat: true,
			entries: [
				{ id: uuid(701), programId: outgoing.id, count: 1 },
				{ id: uuid(702), programId: incoming.id, count: 1 },
			],
		},
	};
	const boundary = { policy: 'finish-left', maxDriftSeconds: 0, fallback: 'favor-right', earlyStartMaxDriftSeconds: 0 } as const;
	const rootProgramId = nested ? sequence.id : outgoing.id;
	const base: ScheduleTemplate = {
		id: uuid(100), ...timestamps,
		...scheduleTemplateCreateSchema.parse({
			name: 'Base',
			slots: [
				{ id: uuid(200), startSeconds: 0, programId: origin === 'layer-exit' ? incoming.id : rootProgramId },
				{ id: uuid(201), startSeconds: 3600, programId: incoming.id },
			],
			boundaries: [
				{ id: uuid(300), leftSlotId: uuid(200), rightSlotId: uuid(201), targetSeconds: 3600, ...boundary },
				{ id: uuid(301), leftSlotId: uuid(201), rightSlotId: uuid(200), targetSeconds: SECONDS_PER_SCHEDULING_DAY },
			],
		}),
	};
	const overlay: ScheduleTemplate = {
		id: uuid(101), ...timestamps,
		...scheduleTemplateCreateSchema.parse({
			name: 'Overlay',
			slots: [{ id: uuid(202), startSeconds: 0, programId: origin === 'layer-entry' ? incoming.id : rootProgramId }],
			boundaries: [{ id: uuid(302), leftSlotId: uuid(202), rightSlotId: uuid(202), targetSeconds: SECONDS_PER_SCHEDULING_DAY }],
		}),
	};
	const media: SchedulableMedia[] = [1, 2, 3].map((id) => ({
		id: uuid(id), libraryId: uuid(900), groupId: null, kind: 'movie', title: `Movie ${id}`,
		sortTitle: `Movie ${id}`, playbackPath: `/media/${id}.mkv`, durationSeconds: id === 3 ? 3600 : 1800,
		seasonNumber: null, episodeNumber: null, genres: [], genreNames: [], plot: null, year: null,
		artworkUrl: null, availability: 'available',
	}));
	return {
		channelId: uuid(50), timeZone: 'UTC', startDate: '2026-01-05', days: 1,
		template: base, templates: [base, overlay], programs: [outgoing, incoming, sequence], state: [],
		schedule: {
			channelId: uuid(50), ...timestamps,
			...channelScheduleConfigSchema.parse({
				defaultTemplateId: base.id,
				layers: origin === 'template' ? [] : [{
					id: uuid(600), templateId: overlay.id,
					predicate: {
						type: 'time-range', startSeconds: origin === 'layer-entry' ? 3600 : 0,
						endSeconds: origin === 'layer-entry' ? 0 : 3600,
					},
					entryBoundary: boundary, exitBoundary: boundary,
				}],
			}),
		},
		catalog: {
			media, groupParents: {}, groupTitles: {}, libraryNames: { [uuid(900)]: 'Movies' },
			libraryAvailability: { [uuid(900)]: 'available' },
		},
	};
}

describe('boundary failure diagnostics', () => {
	it.each(origins.flatMap((origin) => [false, true].flatMap((nested) =>
		['unavailable', 'unmeasured', 'missing'].map((failure) => ({ origin, nested, failure })))))('keeps $failure source errors actionable at $origin (sequence: $nested)', ({ origin, nested, failure }) => {
		const input = fixture(origin, nested);
		if (failure === 'missing') {
			input.catalog.media = input.catalog.media.slice(2);
		}
		else {
			for (const media of input.catalog.media.slice(0, 2)) {
				if (failure === 'unavailable') {
					media.availability = 'unconfirmed';
				}
				else {
					media.durationSeconds = null;
				}
			}
		}
		const result = generateTimeline(input);
		const [diagnostic] = deadAirDiagnostics(result, input.templates, input.schedule);

		expect(result.segments[0]).toMatchObject({ role: 'dead-air', start: '2026-01-05T00:00:00Z', finish: '2026-01-05T01:00:00Z' });
		expect(result.issues.some((issue) => issue.code === 'boundary-start-rejected')).toBe(false);
		expect(diagnostic?.category).toBe('source');
		expect(deadAirAction(diagnostic!)).toMatchObject({ type: 'program', programId: uuid(10) });
		expect(result.proposedState.some((record) => record.consumerKey.includes(uuid(10)) || record.consumerKey.includes(uuid(12)))).toBe(false);
	});

	it.each(origins.flatMap((origin) => [false, true].map((nested) => ({ origin, nested }))))('retains genuine fit rejections at $origin (sequence: $nested)', ({ origin, nested }) => {
		const input = fixture(origin, nested);
		input.catalog.media[0]!.durationSeconds = null;
		input.catalog.media[1]!.durationSeconds = 5400;
		const result = generateTimeline(input);
		const [diagnostic] = deadAirDiagnostics(result, input.templates, input.schedule);

		expect(result.issues.some((issue) => issue.code === 'media-duration-missing')).toBe(true);
		expect(diagnostic?.category).toBe('boundary');
		expect(diagnostic?.issue?.occurrences).toContainEqual({
			start: '2026-01-05T00:00:00Z', finish: '2026-01-05T01:00:00Z', boundaryOrigin: origin,
		});
		expect(deadAirAction(diagnostic!)).toMatchObject(origin === 'template'
			? { type: 'template', templateId: input.template.id }
			: { type: 'layer-boundary', layerId: uuid(600), origin });
		expect(result.proposedState.some((record) => record.consumerKey.includes(uuid(10)) || record.consumerKey.includes(uuid(12)))).toBe(false);
	});

	it('does not label a completed sequence as a boundary fit failure', () => {
		const input = fixture('template', true);
		const config = input.programs[2]!.config;
		if (config.type !== 'sequence') {
			throw new Error('Expected a sequence fixture');
		}
		config.entries = config.entries.slice(0, 1);
		config.repeat = false;
		const result = generateTimeline(input);

		expect(result.segments.slice(0, 2)).toMatchObject([
			{ role: 'primary', start: '2026-01-05T00:00:00Z', finish: '2026-01-05T00:30:00Z' },
			{ role: 'dead-air', start: '2026-01-05T00:30:00Z', finish: '2026-01-05T01:00:00Z' },
		]);
		expect(result.issues.some((issue) => issue.code === 'boundary-start-rejected')).toBe(false);
	});
});
