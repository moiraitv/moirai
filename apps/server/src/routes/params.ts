import { z } from 'zod';

/** Parse a route identifier and reject blank or repeated values. */
export function parseId(request: { params: unknown }): string {
	return z.object({ id: z.uuid() }).parse(request.params).id;
}
