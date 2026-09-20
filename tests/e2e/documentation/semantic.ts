import path from 'node:path';
import { createDatabase } from '../../../apps/server/src/db/index';
import { SemanticRepository } from '../../../apps/server/src/repository/semantic';
import { EMBEDDING_DIMENSIONS } from '../../../apps/server/src/semantic/input';

/** Seed deterministic illustrative vectors so guide captures never require a downloaded model. */
export function seedSemanticCache(directory: string): void {
	const database = createDatabase(path.join(directory, 'data/moirai.sqlite'), path.resolve('drizzle'));
	try {
		const semantic = new SemanticRepository(database.db);
		semantic.reconcile();
		const inputs = semantic.inputs().sort((left, right) => left.text.localeCompare(right.text));
		semantic.preferences.catalog(['superhero movies', 'Space exploration and first contact']);
		for (const job of semantic.preferences.pending()) {
			semantic.preferences.store(job.hash, [job.text === 'superhero movies' ? 0 : 1, job.text === 'superhero movies' ? 1 : 0, ...Array<number>(EMBEDDING_DIMENSIONS - 2).fill(0)]);
		}
		semantic.storeBatch(inputs.map((input, index) => ({ input,
			vector: [1, index / 100, ...Array<number>(EMBEDDING_DIMENSIONS - 2).fill(0)] })));
	}
	finally {
		database.close();
	}
}
