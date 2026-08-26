import { describe, expect, it } from 'vitest';
import type { SchedulingOverview } from '@moirai/shared';
import { countProgramUsages } from '@web/program-usage';

describe('program usage counts', () => {
	it('counts primary, sequence, template filler, slot filler, and channel filler references', () => {
		const overview = {
			programs: [
				{
					id: 'sequence',
					name: 'Sequence',
					createdAt: '',
					updatedAt: '',
					config: {
						type: 'sequence',
						repeat: true,
						entries: [{ id: crypto.randomUUID(), programId: 'filler', count: 1 }],
					},
				},
			],
			templates: [
				{
					id: 'template',
					name: 'Daily',
					period: 'day',
					createdAt: '',
					updatedAt: '',
					defaultFiller: { programId: 'filler', policy: 'best-fit-or-truncate' },
					slots: [
						{
							id: crypto.randomUUID(),
							startSeconds: 0,
							programId: 'primary',
							stateScope: 'persistent',
							startEligibility: { type: 'require-fit' },
							filler: {
								mode: 'configured',
								config: { programId: 'filler', policy: 'best-fit-or-truncate' },
							},
						},
					],
					boundaries: [],
				},
			],
			channelSchedules: [
				{
					channelId: crypto.randomUUID(),
					defaultTemplateId: crypto.randomUUID(),
					layers: [],
					defaultFiller: { programId: 'filler', policy: 'best-fit-or-truncate' },
					createdAt: '',
					updatedAt: '',
				},
			],
			programStatuses: [],
		} as SchedulingOverview;

		expect(countProgramUsages(overview)).toEqual(
			new Map([
				['filler', 4],
				['primary', 1],
			]),
		);
	});
});
