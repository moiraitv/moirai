import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Compare millisecond-backed timeline instants without text ordering or floating-point arithmetic.
 * Keep this expression identical to the timeline expression indexes in the database migrations.
 */
export function instantMilliseconds(value: SQLWrapper): SQL<number> {
	return sql<number>`(CAST(strftime('%s', ${value}) AS INTEGER) * 1000 + CAST(substr(strftime('%f', ${value}), 4, 3) AS INTEGER))`;
}
