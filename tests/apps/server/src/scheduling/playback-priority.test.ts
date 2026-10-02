import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { Repository } from '@server/repository/index.js';
import type { MoiraiDatabase } from '@server/db/index.js';

const workers = vi.hoisted(() => [] as Array<EventEmitter & { messages: Array<{ id: number; kind: string }>; postMessage: (message: { id: number; kind: string }) => void; terminate: () => Promise<number> }>);
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
	messages: Array<{ id: number; kind: string }> = [];
	constructor() {
		super();
		workers.push(this);
	}
	postMessage(message: { id: number; kind: string }) {
		this.messages.push(message);
	}
	async terminate() {
		return 0;
	}
} }));
import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';

afterEach(() => {
	workers.length = 0;
});

function pool(count: number, limit = 8) {
	return new SchedulingWorkerPool(count, limit, {
		db: { $client: { name: '/fixture.sqlite' } } as unknown as MoiraiDatabase,
		repository: { schedulingCatalogRevision: 1 } as unknown as Repository,
	});
}

it('uses the reserved idle worker for playback while materialization is awaiting a commit', async () => {
	const owner = pool(2);
	const materialization = owner.materialize('UTC', async () => {}, () => {});
	const playback = owner.playoutRead({ kind: 'playout-preparation', channelId: 'channel', timeZone: 'UTC', startDate: '2026-10-02', days: 3 }, true);
	const settled = Promise.allSettled([materialization, playback]);
	try {
		expect(workers[0]!.messages[0]?.kind).toBe('materialize');
		expect(workers[1]!.messages[0]?.kind).toBe('playout-read');
	}
	finally {
		await owner.close();
		await settled;
	}
});

it('dispatches queued playback ahead of guide work when the only worker becomes available', async () => {
	const owner = pool(1);
	const materialization = owner.materialize('UTC', async () => {}, () => {});
	const guide = owner.read({ kind: 'guide', startDate: '2026-10-02', days: 3, timeZone: 'UTC', publicUrl: 'http://localhost' });
	const playback = owner.playoutRead({ kind: 'playout-preparation', channelId: 'channel', timeZone: 'UTC', startDate: '2026-10-02', days: 3 }, true);
	const settled = Promise.allSettled([materialization, guide, playback]);
	try {
		workers[0]!.emit('message', { id: workers[0]!.messages[0]!.id, result: false });
		expect(workers[0]!.messages[1]?.kind).toBe('playout-read');
	}
	finally {
		await owner.close();
		await settled;
	}
});

it('runs a live tune ahead of an earlier periodic preparation', async () => {
	const owner = pool(1);
	const request = { kind: 'playout-preparation' as const, channelId: 'periodic', timeZone: 'UTC', startDate: '2026-10-02', days: 3 };
	const background = owner.materialize('UTC', async () => {}, () => {});
	const periodic = owner.playoutRead(request);
	const live = owner.playoutRead({ ...request, channelId: 'live' }, true);
	const settled = Promise.allSettled([background, periodic, live]);
	try {
		workers[0]!.emit('message', { id: workers[0]!.messages[0]!.id, result: false });
		expect(workers[0]!.messages[1]).toMatchObject({ kind: 'playout-read', input: { request: { channelId: 'live' } } });
	}
	finally {
		await owner.close();
		await settled;
	}
});

it('promotes existing queued periodic work onto the reserved worker without duplicating it', async () => {
	const owner = pool(2);
	const background = owner.materialize('UTC', async () => {}, () => {});
	const periodic = owner.playoutRead({ kind: 'playout-preparation', channelId: 'channel', timeZone: 'UTC', startDate: '2026-10-02', days: 3 });
	const settled = Promise.allSettled([background, periodic]);
	try {
		expect(workers[1]!.messages).toHaveLength(0);
		owner.promotePlayout('channel');
		owner.promotePlayout('channel');
		expect(workers[1]!.messages).toHaveLength(1);
		expect(workers[1]!.messages[0]?.kind).toBe('playout-read');
	}
	finally {
		await owner.close();
		await settled;
	}
});

it('reserves bounded live capacity when ordinary admission is full, including a one-entry queue', async () => {
	const owner = pool(1, 1);
	const request = { kind: 'playout-preparation' as const, channelId: 'channel', timeZone: 'UTC', startDate: '2026-10-02', days: 3 };
	const background = owner.materialize('UTC', async () => {}, () => {});
	const live = owner.playoutRead(request, true);
	const settled = Promise.allSettled([background, live]);
	try {
		await expect(owner.playoutRead({ ...request, channelId: 'periodic' })).rejects.toMatchObject({ statusCode: 503 });
		await expect(owner.playoutRead({ ...request, channelId: 'excess' }, true)).rejects.toMatchObject({ statusCode: 503 });
		workers[0]!.emit('message', { id: workers[0]!.messages[0]!.id, result: false });
		expect(workers[0]!.messages[1]?.kind).toBe('playout-read');
	}
	finally {
		await owner.close();
		await settled;
	}
});
