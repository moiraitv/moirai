import type Database from 'better-sqlite3';
import { orderedCast, topBilledActorMatches } from '../media/cast.js';

/** Register bounded cast matching on connections that execute catalog filters. */
export function registerCastFunctions(sqlite: Database.Database): void {
	sqlite.function('moirai_top_billed_actor_matches', { deterministic: true }, (value, query) => {
		if (typeof value !== 'string' || typeof query !== 'string') {
			return 0;
		}

		const metadata: unknown = JSON.parse(value);
		const actors = metadata && typeof metadata === 'object' && 'actors' in metadata ? metadata.actors : undefined;
		return Number(topBilledActorMatches(orderedCast(actors), query));
	});
}
