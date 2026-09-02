import { programCreateSchema, type ProgramCreate } from '@moirai/shared';

/** Validate a program payload while treating draft-construction failures as incomplete input. */
export function isProgramDraftValid(payload: () => ProgramCreate): boolean {
	try {
		return programCreateSchema.safeParse(payload()).success;
	}
	catch {
		return false;
	}
}
