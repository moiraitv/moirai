import { z } from 'zod';

/** Maximum number of custom fields authored on one Program. */
export const MAX_PROGRAM_METADATA_FIELDS = 16;

/** Maximum length of a Liquid identifier used as a Program metadata key. */
export const MAX_PROGRAM_METADATA_KEY_LENGTH = 64;

/** Maximum length of a single authored metadata value. */
export const MAX_PROGRAM_METADATA_VALUE_LENGTH = 256;

/** Accept identifiers that can be safely read as own properties in Liquid. */
export const programMetadataKeySchema = z.string().max(MAX_PROGRAM_METADATA_KEY_LENGTH)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.refine(key => !Object.hasOwn(Object.prototype, key) && key !== 'prototype', 'Reserved metadata key');

/** Validate a resolved map, which can contain fields from several Programs. */
export const resolvedProgramMetadataSchema = z.record(programMetadataKeySchema, z.string().max(MAX_PROGRAM_METADATA_VALUE_LENGTH));

/** Bound authored maps at the Program boundary before accepting their properties. */
export const programMetadataSchema = z.unknown()
	.refine(value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
		&& Object.keys(value).length <= MAX_PROGRAM_METADATA_FIELDS
		&& Object.keys(value).every(key => programMetadataKeySchema.safeParse(key).success)), 'Invalid Program metadata keys or field count')
	.and(resolvedProgramMetadataSchema).meta({ maxProperties: MAX_PROGRAM_METADATA_FIELDS });

/** Plain text values supplied by one Program or resolved from several Programs. */
export type ProgramMetadata = z.infer<typeof resolvedProgramMetadataSchema>;

/** Merge ancestor fields in selection order, preserving child overrides including blanks. */
export function mergeProgramMetadata(sources: Iterable<ProgramMetadata | undefined>): ProgramMetadata {
	const fields: ProgramMetadata = Object.create(null);
	for (const source of sources) {
		Object.assign(fields, source);
	}
	return { ...fields };
}

/** Template values associated with one committed selection. */
export const programTemplateContextSchema = z.object({ metadata: resolvedProgramMetadataSchema });

/** Keep the metadata namespace present when no Program supplied values. */
export type ProgramTemplateContext = z.infer<typeof programTemplateContextSchema>;

/** Liquid values that carry a Program for the clip or one of its neighboring airings. */
interface ProgramMetadataScopes {
	program?: ProgramTemplateContext | undefined;
	now?: { program?: ProgramTemplateContext | undefined } | null | undefined;
	next?: { program?: ProgramTemplateContext | undefined } | null | undefined;
	upcoming?: readonly { program?: ProgramTemplateContext | undefined }[] | undefined;
}

/** Read metadata keys literally so missing fields cannot resolve to Liquid's virtual properties. */
export function useProgramMetadataLookup<ObjectValue, Key>(
	context: { readProperty(object: ObjectValue, key: Key): unknown },
	values: ProgramMetadataScopes,
): void {
	const maps = new Map<unknown, ProgramMetadata>();
	for (const program of [values.program, values.now?.program, values.next?.program, ...values.upcoming?.map(airing => airing.program) ?? []]) {
		if (program) {
			maps.set(program.metadata, program.metadata);
		}
	}
	if (!maps.size) {
		return;
	}

	const read = context.readProperty.bind(context);
	context.readProperty = (object, key) => {
		const metadata = maps.get(object);
		if (metadata) {
			return typeof key === 'string' && Object.hasOwn(metadata, key) ? metadata[key] : null;
		}
		return read(object, key);
	};
}
