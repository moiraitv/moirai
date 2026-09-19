import { z } from 'zod';

/** Saved resources whose authored references or current media membership can be inspected. */
export const resourceUsageParamsSchema = z.object({
	kind: z.enum(['program', 'template', 'encoding-profile', 'credit-template', 'guide-template', 'media']),
	id: z.uuid(),
});
/** Bounded pages for resource owners or realized showings. */
export const resourceUsageQuerySchema = z.object({
	page: z.coerce.number().int().min(1).max(1_000_000).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
/** Named owners and their authored reference or current membership roles; indirect impact is excluded. */
export const resourceUsageResponseSchema = z.object({
	items: z.array(z.object({
		kind: z.enum(['program', 'template', 'channel-schedule', 'channel']),
		id: z.uuid(), name: z.string(), roles: z.array(z.string()), referenceCount: z.number().int().positive(),
	})),
	total: z.number().int().nonnegative(),
});
/** Kind of resource supported by usage inspection. */
export type ResourceUsageKind = z.infer<typeof resourceUsageParamsSchema>['kind'];
/** One page of referencing resources or matching content programs. */
export type ResourceUsage = z.infer<typeof resourceUsageResponseSchema>;

/** Current and upcoming item occurrences already committed to channel schedules. */
export const mediaAiringsResponseSchema = z.object({
	items: z.array(z.object({
		id: z.string(), channelId: z.uuid(), channelName: z.string(), channelNumber: z.string(),
		startsAt: z.iso.datetime(), finishesAt: z.iso.datetime(),
	})),
	total: z.number().int().nonnegative(),
});
/** One bounded page of realized media showings. */
export type MediaAirings = z.infer<typeof mediaAiringsResponseSchema>;
