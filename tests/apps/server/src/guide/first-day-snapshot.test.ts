import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { channelCreateSchema, type LiveEvent } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { FirstDayGuideSnapshot } from '@server/guide/first-day-snapshot.js';
import type { GuideReadRequest, GuideReadResult } from '@server/guide/read-job.js';
import { firstDayGuideKey } from '@server/guide/snapshot-key.js';
import { Repository } from '@server/repository/index.js';

async function fixture(canWarmGuide = false) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-first-day-'));
	const config = { dataDir: root, timeZone: 'America/Los_Angeles', publicUrl: 'http://localhost', guideDays: 3 };
	const file = path.join(root, 'moirai.sqlite');
	const database = createDatabase(file, path.resolve('drizzle'));
	const repository = new Repository(database.db);
	const request = (): GuideReadRequest => ({ kind: 'guide', days: 1, guideDays: config.guideDays,
		timeZone: config.timeZone, publicUrl: config.publicUrl,
		startDate: Temporal.Now.plainDateISO(config.timeZone).toString() });
	const load = vi.fn(async (input: GuideReadRequest) => ({
		body: JSON.stringify({ channels: await repository.listChannels(), date: input.startDate }),
		snapshotKey: firstDayGuideKey(database.db, input),
	}));
	const warmGuide = vi.fn<(input: GuideReadRequest) => Promise<GuideReadResult | undefined>>(input => load(input));
	const services: FirstDayGuideSnapshot[] = [];
	const start = async (db = database.db, overrides = {}) => {
		const service = new FirstDayGuideSnapshot({ ...config, ...overrides }, db, { canWarmGuide, warmGuide }, vi.fn());
		services.push(service);
		await service.start();
		return service;
	};
	const cleanup = async () => {
		await Promise.all(services.map(service => service.close()));
		database.close();
		await rm(root, { recursive: true, force: true });
	};
	return { root, file, database, repository, request, load, warmGuide, start, cleanup };
}

function channelUpdate(channelId: string = randomUUID()): LiveEvent {
	return { type: 'channel.changed', protocolVersion: 1, eventId: randomUUID(),
		occurredAt: new Date().toISOString(), data: { channelId, change: 'updated' } };
}

afterEach(() => {
	vi.useRealTimers();
});

it('recovers the first-day response with a fresh SQLite connection and bypasses future days and wider windows', async () => {
	const state = await fixture();
	try {
		const channel = await state.repository.createChannel(channelCreateSchema.parse({ name: 'First channel', number: '1' }));
		const before = await state.start();
		const body = await before.read(state.request(), state.load);
		expect(body.toString()).toContain(channel.name);
		await before.close();

		const reopened = createDatabase(state.file, path.resolve('drizzle'));
		try {
			const after = await state.start(reopened.db);
			expect(await after.read(state.request(), state.load)).toEqual(body);
			expect(state.load).toHaveBeenCalledTimes(1);

			const tomorrow = Temporal.PlainDate.from(state.request().startDate).add({ days: 1 }).toString();
			await after.read({ ...state.request(), startDate: tomorrow }, state.load);
			await after.read({ ...state.request(), days: 2 }, state.load);
			expect(state.load).toHaveBeenCalledTimes(3);
			await after.close();

			const publicUrl = 'https://moirai.example.test';
			const reconfigured = await state.start(reopened.db, { publicUrl });
			await reconfigured.read({ ...state.request(), publicUrl }, state.load);
			expect(state.load).toHaveBeenCalledTimes(4);
			await reconfigured.close();
		}
		finally {
			reopened.close();
		}
	}
	finally {
		await state.cleanup();
	}
});

it('rejects a changed database revision or a corrupt disk artifact at startup', async () => {
	const state = await fixture();
	try {
		const channel = await state.repository.createChannel(channelCreateSchema.parse({ name: 'Before', number: '1' }));
		const old = await state.start();
		await old.read(state.request(), state.load);
		await old.close();
		await state.repository.updateChannel(channel.id, { name: 'After' });

		const changed = await state.start();
		expect((await changed.read(state.request(), state.load)).toString()).toContain('After');
		expect(state.load).toHaveBeenCalledTimes(2);
		await changed.close();

		const filename = path.join(state.root, 'first-day-guide.snapshot');
		const corrupted = await readFile(filename);
		corrupted[corrupted.length - 1] = 0;
		await writeFile(filename, corrupted);
		const recovered = await state.start();
		expect((await recovered.read(state.request(), state.load)).toString()).toContain('After');
		expect(state.load).toHaveBeenCalledTimes(3);
	}
	finally {
		await state.cleanup();
	}
});

it('batches invalidations, discards superseded background output and refreshes at local midnight', async () => {
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	vi.setSystemTime(new Date('2026-11-01T06:59:40Z'));
	const state = await fixture(true);
	try {
		const day = state.request().startDate;
		const stale = await state.load(state.request());
		let release!: (result: GuideReadResult) => void;
		state.warmGuide.mockImplementationOnce(() => new Promise(resolve => {
			release = resolve;
		}));
		const service = await state.start();
		for (let index = 0; index < 5; index += 1) {
			service.handleEvent(channelUpdate());
		}
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.warmGuide).toHaveBeenCalledTimes(1);

		const channel = await state.repository.createChannel(channelCreateSchema.parse({ name: 'New revision', number: '1' }));
		service.handleEvent(channelUpdate(channel.id));
		release(stale);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(state.warmGuide).toHaveBeenCalledTimes(2);
		const body = await service.read(state.request(), async () => {
			throw new Error('Expected a background cache hit');
		});
		expect(body.toString()).toContain(channel.name);

		await vi.advanceTimersByTimeAsync(20_000);
		expect(state.request().startDate).not.toBe(day);
		expect(state.warmGuide).toHaveBeenCalledTimes(3);
		expect(state.warmGuide).toHaveBeenLastCalledWith(expect.objectContaining({ startDate: state.request().startDate }));
	}
	finally {
		await state.cleanup();
	}
});
