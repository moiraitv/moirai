import { describe, expect, it } from 'vitest';
import type { ScheduleTemplateCreate, SchedulingProgram } from '@moirai/shared';
import { SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import { SchedulingValidationError, validatePrograms, validateTemplate } from '@server/scheduling/validation.js';

const uuid = (value: number): string =>
	`00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

function contentProgram(value: number): SchedulingProgram {
	return {
		id: uuid(value),
		name: `Program ${value}`,
		config: {
			type: 'content',
			source: { type: 'item', itemId: uuid(900 + value) },
			strategy: { type: 'sequential' },
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

describe('schedule configuration validation', () => {
	it('requires explicit boundaries to describe the adjacent nominal slots', () => {
		const first = contentProgram(1);
		const second = contentProgram(2);
		const slots = [
			{
				id: uuid(10),
				startSeconds: 0,
				programId: first.id,
				stateScope: 'persistent' as const,
				startEligibility: { type: 'require-fit' as const },
				filler: { mode: 'inherit' as const },
			},
			{
				id: uuid(11),
				startSeconds: 43_200,
				programId: second.id,
				stateScope: 'persistent' as const,
				startEligibility: { type: 'require-fit' as const },
				filler: { mode: 'inherit' as const },
			},
		];
		const valid: ScheduleTemplateCreate = {
			name: 'Daily',
			period: 'day',
			defaultFiller: null,
			slots,
			boundaries: [
				{
					id: uuid(20),
					leftSlotId: slots[0]!.id,
					rightSlotId: slots[1]!.id,
					targetSeconds: slots[1]!.startSeconds,
					policy: 'hard',
					maxDriftSeconds: 0,
					fallback: 'reject-start',
				},
				{
					id: uuid(21),
					leftSlotId: slots[1]!.id,
					rightSlotId: slots[0]!.id,
					targetSeconds: SECONDS_PER_SCHEDULING_DAY,
					policy: 'hard',
					maxDriftSeconds: 0,
					fallback: 'reject-start',
				},
			],
		};
		expect(() => validateTemplate(valid, [first, second])).not.toThrow();
		expect(() =>
			validateTemplate(
				{
					...valid,
					boundaries: [
						{ ...valid.boundaries[0]!, targetSeconds: slots[1]!.startSeconds + 1 },
						valid.boundaries[1]!,
					],
				},
				[first, second],
			)).toThrow(SchedulingValidationError);
	});

	it('rejects recursive composite programs', () => {
		const first: SchedulingProgram = {
			...contentProgram(1),
			config: {
				type: 'sequence',
				entries: [{ id: uuid(30), programId: uuid(2), count: 1 }],
				repeat: true,
			},
		};
		const second: SchedulingProgram = {
			...contentProgram(2),
			config: {
				type: 'sequence',
				entries: [{ id: uuid(31), programId: uuid(1), count: 1 }],
				repeat: true,
			},
		};
		expect(() => validatePrograms([first, second])).toThrow(SchedulingValidationError);
	});
});
