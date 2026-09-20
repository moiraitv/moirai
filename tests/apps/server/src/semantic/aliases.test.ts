import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { selectProgram } from '@server/scheduling/selection.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { fixture } from './fixtures.js';

it('finishes a committed set after a rescan absorbs a remaining item into a logical multipart item', async () => {
	const f = await fixture();
	try {
		await f.embeddings();
		const first = selectProgram(f.program.id, f.key, new Map(), await f.context())!;
		const value = first.state.get(f.key)!.value;
		if (value.type !== 'similarity') {
			throw new Error('Expected a similarity seed');
		}
		const originalSeed = structuredClone(value.seed);
		const absorbed = value.seed.itemIds[1]!;
		f.commit([...first.state.values()]);

		const discovery = await discoverOnDisk(f.library, { probeMedia: async () => ({ durationMilliseconds: 60_000, fileSizeBytes: 7, container: 'mp4', streams: [], resolution: null, tags: {} }) });
		const logicalId = randomUUID();
		const items = discovery.items.map((item) => item.id === absorbed
			? { ...item, id: logicalId, relativePath: 'Logical multipart movie', stableKey: logicalId, aliasIds: [absorbed], multipartStatus: 'complete' as const } : item);
		await f.repository.reconcileScan(await f.repository.beginScan(f.library.id, 'initial'), discovery.groups, items, [], true);
		f.reopen();
		const context = await f.context();
		expect(context.catalog.mediaAliases?.[absorbed]).toBe(logicalId);
		expect(context.catalog.media.some((item) => item.id === absorbed)).toBe(false);
		const persisted = new Map((await f.repository.getSelectionState(f.channel.id)).map((record) => [record.consumerKey, record]));
		const baseline = structuredClone(persisted);
		expect(selectProgram(f.program.id, f.key, persisted, context, 30, 'first-fit-arbitrary')).toBeNull();
		expect(persisted).toEqual(baseline);
		const second = selectProgram(f.program.id, f.key, persisted, context)!;
		expect(second?.media.id).toBe(logicalId);
		expect(second.state.get(f.key)?.value).toMatchObject({ seed: originalSeed, consumedItemIds: [first.media.id, absorbed] });
		f.commit([...second.state.values()]);
		f.reopen();

		const restored = new Map((await f.repository.getSelectionState(f.channel.id)).map((record) => [record.consumerKey, record]));
		const third = selectProgram(f.program.id, f.key, restored, await f.context())!;
		expect(third.state.get(f.key)?.value).toMatchObject({ seed: originalSeed, consumedItemIds: originalSeed.itemIds });
		f.commit([...third.state.values()]);
		await f.embeddings();
		f.repository.invalidateSchedulingCatalog();
		const next = selectProgram(f.program.id, f.key, third.state, await f.context())!;
		expect(next.state.get(f.key)?.value).toMatchObject({ seed: { generation: originalSeed.generation + 1 } });
		expect(f.semantic.seeds().find((seed) => seed.generation === originalSeed.generation)).toEqual(originalSeed);
	}
	finally {
		await f.close();
	}
});
