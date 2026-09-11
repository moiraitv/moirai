import { Temporal } from '@js-temporal/polyfill';
import { SECONDS_PER_SCHEDULING_DAY, type ChannelScheduleLayer, type ScheduleBoundary,
	type ScheduleSlot, type ScheduleTemplate } from '@moirai/shared';
import type { GenerateTimelineInput } from './engine.js';
import { predicateTimeBoundaries, schedulePredicateMatches } from './predicate.js';

/** Convert a local template date and offset into an absolute instant. */
export function instantFor(date: Temporal.PlainDate, seconds: number, timeZone: string): Temporal.Instant {
	const targetDate = seconds === SECONDS_PER_SCHEDULING_DAY ? date.add({ days: 1 }) : date;
	const secondsInDate = seconds === SECONDS_PER_SCHEDULING_DAY ? 0 : seconds;
	const dateTime = targetDate.toPlainDateTime('00:00').add({ seconds: secondsInDate });
	return dateTime.toZonedDateTime(timeZone, { disambiguation: 'compatible' }).toInstant();
}

/** Effective slot after calendar predicates and template layering are resolved. */
export interface ResolvedScheduleSlot {
	template: ScheduleTemplate;
	layerId: string | null;
	layerIndex: number;
	slot: ScheduleSlot;
	startSeconds: number;
	endSeconds: number;
	boundary: ScheduleBoundary;
	boundaryOrigin: 'template' | 'layer-entry' | 'layer-exit';
	boundaryLayerId: string | null;
}

/** Return the nominal template slot active at a wall-clock offset. */
function slotAt(template: ScheduleTemplate, seconds: number): ScheduleSlot {
	const slots = [...template.slots].sort((left, right) => left.startSeconds - right.startSeconds);
	return [...slots].reverse().find((slot) => slot.startSeconds <= seconds) ?? slots[0]!;
}

/** Resolve the authored boundary after a template slot. */
function templateBoundary(template: ScheduleTemplate, slot: ScheduleSlot): ScheduleBoundary {
	return boundaryFor(template, slot);
}

/** Translate a conditional layer entry or exit rule into a slot boundary. */
function layerBoundary(
	layer: ChannelScheduleLayer,
	side: 'entry' | 'exit',
	leftSlotId: string,
	rightSlotId: string,
	targetSeconds: number,
): ScheduleBoundary {
	const config = side === 'entry' ? layer.entryBoundary : layer.exitBoundary;
	return {
		id: `${layer.id}-${side}-${targetSeconds}`,
		leftSlotId,
		rightSlotId,
		targetSeconds,
		...config,
	};
}

/** Resolve the applicable layered slots for one local scheduling day. */
export function resolveScheduleDay(
	input: Pick<GenerateTimelineInput, 'template' | 'templates' | 'schedule' | 'timeZone'>,
	date: Temporal.PlainDate,
): ResolvedScheduleSlot[] {
	// Collect every template and predicate transition that can divide the local day.
	const templateMap = new Map(
		[input.template, ...(input.templates ?? [])].map((template) => [template.id, template]),
	);
	const boundaries = new Set<number>([0, SECONDS_PER_SCHEDULING_DAY]);
	for (const template of templateMap.values()) {
		for (const slot of template.slots) {
			boundaries.add(slot.startSeconds);
		}
	}
	for (const layer of input.schedule.layers) {
		for (const seconds of predicateTimeBoundaries(layer.predicate)) {
			boundaries.add(seconds);
		}
	}
	const points = [...boundaries].sort((left, right) => left - right);

	// Select the highest matching layer with programming, falling through no-program slots.
	const selectionAt = (
		selectionDate: Temporal.PlainDate,
		startSeconds: number,
	): Omit<
		ResolvedScheduleSlot,
		'startSeconds' | 'endSeconds' | 'boundary' | 'boundaryOrigin' | 'boundaryLayerId'
	> => {
		const instant = instantFor(selectionDate, startSeconds, input.timeZone);
		for (const [layerIndex, layer] of input.schedule.layers.entries()) {
			const template = templateMap.get(layer.templateId);
			if (!template || !schedulePredicateMatches(layer.predicate, instant, input.timeZone)) {
				continue;
			}

			const slot = slotAt(template, startSeconds);
			if (slot.programId !== null) {
				return { template, layerId: layer.id, layerIndex, slot };
			}
		}
		return {
			template: input.template,
			layerId: null,
			layerIndex: Number.MAX_SAFE_INTEGER,
			slot: slotAt(input.template, startSeconds),
		};
	};

	// Resolve each interval and merge adjacent intervals with the same effective slot.
	const preliminary: Omit<
		ResolvedScheduleSlot,
		'boundary' | 'boundaryOrigin' | 'boundaryLayerId'
	>[] = [];
	for (let index = 0; index < points.length - 1; index += 1) {
		const startSeconds = points[index]!;
		const endSeconds = points[index + 1]!;
		const selected = selectionAt(date, startSeconds);
		const previous = preliminary.at(-1);
		if (
			previous
			&& previous.template.id === selected.template.id
			&& previous.layerId === selected.layerId
			&& previous.slot.id === selected.slot.id
		) {
			previous.endSeconds = endSeconds;
		}
		else {
			preliminary.push({ ...selected, startSeconds, endSeconds });
		}
	}

	// Replace template boundaries with entry or exit policies at layer transitions.
	return preliminary.map((current, index) => {
		const next = preliminary[index + 1] ?? selectionAt(date.add({ days: 1 }), 0);
		let boundary = templateBoundary(current.template, current.slot);
		let boundaryOrigin: ResolvedScheduleSlot['boundaryOrigin'] = 'template';
		let boundaryLayerId = current.layerId;
		if (current.layerId !== next.layerId) {
			if (next.layerId && next.layerIndex < current.layerIndex) {
				const entering = input.schedule.layers.find((layer) => layer.id === next.layerId)!;
				boundary = layerBoundary(
					entering,
					'entry',
					current.slot.id,
					next.slot.id,
					current.endSeconds,
				);
				boundaryOrigin = 'layer-entry';
				boundaryLayerId = next.layerId;
			}
			else if (current.layerId) {
				const exiting = input.schedule.layers.find((layer) => layer.id === current.layerId)!;
				boundary = layerBoundary(
					exiting,
					'exit',
					current.slot.id,
					next.slot.id,
					current.endSeconds,
				);
				boundaryOrigin = 'layer-exit';
			}
		}
		return {
			...current,
			boundary: { ...boundary, targetSeconds: current.endSeconds },
			boundaryOrigin,
			boundaryLayerId,
		};
	});
}

/** Return the explicit outgoing boundary for a resolved slot. */
function boundaryFor(template: ScheduleTemplate, slot: ScheduleSlot): ScheduleBoundary {
	const boundary = template.boundaries.find((candidate) => candidate.leftSlotId === slot.id);
	if (!boundary) {
		throw new Error(`Template ${template.id} has no boundary for slot ${slot.id}`);
	}

	return boundary;
}

