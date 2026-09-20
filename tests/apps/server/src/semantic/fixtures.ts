import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelCreateSchema, libraryCreateSchema, programCreateSchema } from '@moirai/shared';
import type { SelectionStateRecord } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { SemanticRepository } from '@server/repository/semantic.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import type { SelectionContext } from '@server/scheduling/selection.js';
import { EMBEDDING_DIMENSIONS } from '@server/semantic/input.js';

export function vector(x = 1, y = 0): number[] {
	return [x, y, ...Array<number>(EMBEDDING_DIMENSIONS - 2).fill(0)];
}

export async function fixture(itemCount = 8) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-semantic-'));
	const filename = path.join(root, 'db.sqlite');
	let database = createDatabase(filename, path.resolve('drizzle'));
	let repository = new Repository(database.db);
	let semantic = new SemanticRepository(database.db);
	const library = await repository.createLibrary(libraryCreateSchema.parse({ name: 'Films', typeKey: 'movies', sourceType: 'on-disk', sourceConfig: { scanRoot: root } }));
	for (let i = 0; i < itemCount; i += 1) {
		await writeFile(path.join(root, `Film ${i}.mp4`), 'fixture');
	}
	const discovery = await discoverOnDisk(library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
	await repository.reconcileScan(await repository.beginScan(library.id, 'initial'), discovery.groups, discovery.items, [], true);
	const ids = discovery.items.map((item) => item.id);
	const source = await repository.createProgram(programCreateSchema.parse({ name: 'Anchors', config: { type: 'content', source: { type: 'collection', libraryId: library.id, itemIds: [ids[0]] }, strategy: { type: 'sequential' } } }));
	const program = await repository.createProgram(programCreateSchema.parse({ name: 'Similar', config: { type: 'similarity', sourceProgramId: source.id, quantity: 3, variety: 35 } }));
	const channel = await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Semantic' }));
	const key = `primary:${channel.id}:${randomUUID()}:${randomUUID()}:${program.id}`;
	return {
		root, ids, library, source, program, channel, key,
		get database() {
			return database;
		},
		get repository() {
			return repository;
		},
		get semantic() {
			return semantic;
		},
		async embeddings() {
			for (const input of semantic.reconcile()) {
				semantic.store(input, vector());
			}
		},
		async context(): Promise<SelectionContext> {
			const programs = await repository.listPrograms();
			return { programs: new Map(programs.map((item) => [item.id, item])),
				catalog: await repository.getSchedulingCatalog(programs), candidateCache: new Map(), blockedPrograms: new Set(),
				fitRejectionCount: 0, issues: [], issueKeys: new Set(), issueIndex: new Map(), boundaryOrigin: null,
				templateId: randomUUID(), scheduleLayerId: null, slotId: randomUUID(), now: '2026-09-19T12:00:00Z',
				viewingPreferences: { itemScores: {}, showScores: {} }, selectionStart: '2026-09-19T12:00:00Z', occupiedMedia: [] };
		},
		commit(states: SelectionStateRecord[], expectedCommittedAt?: string | null) {
			repository.commitMaterializedTimeline({ channelId: channel.id, windowStart: '2026-09-19T00:00:00Z',
				windowEnd: '2026-09-20T00:00:00Z', replaceFrom: '2026-09-19T00:00:00Z', continuationAt: '2026-09-20T00:00:00Z',
				inputFingerprint: 'fixture', baseState: states, finalState: states, segments: [], issues: [],
				committedAt: new Date().toISOString(), ...(expectedCommittedAt !== undefined ? { expectedCommittedAt } : {}) });
		},
		reopen() {
			database.close();
			database = createDatabase(filename, path.resolve('drizzle'));
			repository = new Repository(database.db);
			semantic = new SemanticRepository(database.db);
		},
		async close() {
			database.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
