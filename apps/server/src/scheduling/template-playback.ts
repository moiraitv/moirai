import type { ScheduleTemplateCreate, ScheduleTemplate } from '@moirai/shared';

/** Remove presentation settings while preserving the pre-guide scheduling hash shape. */
export function templatePlaybackInput<T extends ScheduleTemplateCreate>(template: T): T {
	const { schedulingUpdatedAt, ...value } = template as T & Partial<ScheduleTemplate>;
	return {
		...value,
		...(schedulingUpdatedAt ? { updatedAt: schedulingUpdatedAt } : {}),
		slots: template.slots.map(({ guide: _guide, ...slot }) => {
			void _guide;
			return slot;
		}),
	} as T;
}
