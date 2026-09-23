import path from 'node:path';
import { expect, it } from 'vitest';
import { channelCreateSchema } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { guideRead } from '@server/guide/read-job.js';
import { Repository } from '@server/repository/index.js';

it('reads legacy channel configs as enabled and persists explicit publication changes', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		const channel = await repository.createChannel(channelCreateSchema.parse({ number: '17', name: 'Legacy' }));
		database.sqlite.prepare("UPDATE channels SET config = json_remove(config, '$.enabled') WHERE id = ?").run(channel.id);
		expect((await repository.getChannel(channel.id))?.enabled).toBe(true);
		expect((await repository.getChannelByNumber('17'))?.enabled).toBe(true);
		expect((await repository.listChannels())[0]?.enabled).toBe(true);
		await repository.updateChannel(channel.id, { enabled: false });
		expect((await new Repository(database.db).getChannel(channel.id))?.enabled).toBe(false);
		await repository.updateChannel(channel.id, { name: 'Renamed' });
		expect((await repository.listChannels())[0]?.enabled).toBe(false);
	}
	finally {
		database.close();
	}
});

it('filters disabled channels from XMLTV worker jobs and restores them when enabled', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repository = new Repository(database.db);
		await repository.createChannel(channelCreateSchema.parse({ number: '1', name: 'Published' }));
		const hidden = await repository.createChannel(channelCreateSchema.parse({ number: '2', name: 'Hidden', enabled: false }));
		const request = { timeZone: 'UTC', publicUrl: 'https://moirai.test', startDate: new Date().toISOString().slice(0, 10), days: 1 };
		const xmltv = await guideRead(repository, { ...request, kind: 'xmltv' });
		expect(xmltv.body).toContain('Published');
		expect(xmltv.body).not.toContain('Hidden');
		await repository.updateChannel(hidden.id, { enabled: true });
		const restored = await guideRead(repository, { ...request, kind: 'xmltv' });
		expect(restored.body).toContain('Hidden');
	}
	finally {
		database.close();
	}
});
