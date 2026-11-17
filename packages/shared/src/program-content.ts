import { z } from 'zod';
import { contentSourceSchema, type ContentSource } from './scheduling.js';

/** Draft sources whose indexed membership can be browsed and excluded. */
export type ProgramContentSource = Extract<ContentSource, { type: 'library-query' | 'collection' | 'group-collection' | 'ai' }>;

/** Reuse the library-scoped variants in both request validation and generated API documentation. */
const librarySourceOptions = contentSourceSchema.options.filter(option => 'libraryId' in option.shape);

/** Preserve all source refinements after validating the supported source variants. */
const programContentSourceSchema = z.discriminatedUnion('type', [librarySourceOptions[0]!, ...librarySourceOptions.slice(1)])
	.superRefine((source, context) => {
		const result = contentSourceSchema.safeParse(source);
		if (!result.success) {
			for (const issue of result.error.issues) {
				context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
			}
		}
	})
	.transform(source => source as ProgramContentSource);

/** Browse one hierarchy level of an uncommitted Program without changing playback state. */
export const programContentBrowseRequestSchema = z.object({
	source: programContentSourceSchema,
	parentId: z.uuid().optional(),
	page: z.number().int().min(1).max(1_000_000).default(1),
	pageSize: z.number().int().min(1).max(100).default(20),
});

/** Validated draft membership and hierarchy page requested by the exclusions drawer. */
export type ProgramContentBrowseRequest = z.infer<typeof programContentBrowseRequestSchema>;
