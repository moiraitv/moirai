import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { scheduleTemplateCreateSchema } from '@moirai/shared';
import { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';
import { fixture, vector } from './fixtures.js';

it.each(['content', 'theme'] as const)('stages and applies corrected runtimes for %s schedules', async (type) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
	const f = await fixture();
	const materializer = new TimelineMaterializer(f.repository, { publish: () => {} }, 'UTC');
	try {
		await f.embeddings();
		const program = type === 'content' ? f.source : await f.repository.createProgram({ name: 'Theme', config: { type: 'theme', libraryId: f.library.id, theme: 'Space', variety: 35, quantity: 3 } });
		f.semantic.preferences.reconcile();
		for (const job of f.semantic.preferences.pending()) {
			f.semantic.preferences.store(job.hash, vector());
		}
		const slotId = randomUUID();
		const template = await f.repository.createScheduleTemplate(scheduleTemplateCreateSchema.parse({ name: 'Daily', slots: [{ id: slotId, programId: program.id, startSeconds: 0 }], boundaries: [{ id: randomUUID(), leftSlotId: slotId, rightSlotId: slotId, targetSeconds: 86400 }] }));
		await f.repository.setChannelSchedule(f.channel.id, { defaultTemplateId: template.id, layers: [], defaultFiller: null });
		f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=21600, duration_milliseconds=21600000').run();
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		expect((await f.repository.getTimelineMaterialization(f.channel.id))?.health).toBe('ready');
		f.database.sqlite.prepare('UPDATE media_items SET duration_seconds=7200, duration_milliseconds=7200000').run();
		f.repository.invalidateSchedulingCatalog();
		await materializer.runNow(true);
		expect(await f.repository.getTimelineMaterialization(f.channel.id)).toMatchObject({ health: 'pending', applyAfter: '2026-09-20T00:00:00Z' });
		vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
		await materializer.runNow(true);
		expect((await f.repository.getTimelineMaterialization(f.channel.id))?.health).toBe('ready');
		const segments = await f.repository.listMaterializedTimelineSegments('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z', f.channel.id);
		const primary = segments.filter(({ segment }) => segment.role === 'primary');
		expect(primary.length).toBeGreaterThan(0);
		expect(primary.every(({ segment }) => Date.parse(segment.finish) - Date.parse(segment.start) === 7_200_000)).toBe(true);
	}
	finally {
		await materializer.close();
		await f.close();
		vi.useRealTimers();
	}
});
