import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { expect, it, vi } from 'vitest';
import { scheduleTemplateCreateSchema, SECONDS_PER_SCHEDULING_DAY } from '@moirai/shared';
import type { FastifyBaseLogger } from 'fastify';
import { EpgService } from '@server/guide/epg.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { FallbackFillerStore } from '@server/playback/fallback-filler-store.js';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';
import { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { fixture } from '../semantic/fixtures.js';

it.each([0, 1])('publishes tomorrow before midnight with a one-day EPG and %i workers', async (workerCount) => {
	const f = await fixture();
	const workers = new SchedulingWorkerPool(workerCount, 4, { db: f.database.db, repository: f.repository });
	const events = { publish: vi.fn() };
	const materializer = new TimelineMaterializer(f.repository, events, 'UTC', workers, undefined, 1);
	const synchronizer = new PlayoutSynchronizer(
		f.repository, 
		path.join(f.root, 'playout'), 
		'UTC', 
		60,
		() => materializer.runNow(), 
		{ resolve: async () => null } as unknown as FallbackFillerStore,
		events, 
		{ debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger, 
		workers, 
		1,
	);
	try {
		f.database.sqlite.exec('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000');
		f.repository.invalidateSchedulingCatalog();
		const slotId = randomUUID();
		const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily',
			slots: [{ id: slotId, programId: f.source.id, startSeconds: 0 }],
			boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: SECONDS_PER_SCHEDULING_DAY }],
		}));
		await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: template.id, layers: [], defaultFiller: null });
		await materializer.runNow();
		const folder = await synchronizer.syncChannel(f.channel.id);
		const files = (await readdir(folder)).filter(name => name.endsWith('.json')).sort();
		expect(files).toHaveLength(2);
		const tomorrow = Temporal.Now.plainDateISO('UTC').add({ days: 1 });
		expect(files[1]).toMatch(new RegExp(`^${tomorrow.toString().replaceAll('-', '')}T000000`));
		const nextDay = JSON.parse(await readFile(path.join(folder, files[1]!), 'utf8'));
		expect(nextDay.items.length).toBeGreaterThan(0);
		expect(Temporal.Instant.compare(nextDay.items[0].start, tomorrow.toZonedDateTime('UTC').toInstant())).toBe(0);

		// The private rollover buffer must not expand the public XMLTV window.
		const epg = new EpgService(f.repository, 'UTC', 'http://localhost', () => materializer.runNow(), undefined, workers, 1);
		const xml = (await epg.document()).body;
		const stops = [...xml.matchAll(/<programme\b[^>]*\bstop="(\d{14})/gu)].map(match => match[1]!);
		expect(stops.sort().at(-1)).toBe(`${tomorrow.toString().replaceAll('-', '')}000000`);
	}
	finally {
		await synchronizer.close();
		await materializer.close();
		await workers.close();
		await f.close();
	}
}, 30_000);
