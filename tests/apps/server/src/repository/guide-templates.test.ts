import path from 'node:path';
import { expect, it } from 'vitest';
import {
	BUILTIN_GUIDE_TEMPLATE,
	channelCreateSchema,
	guideTemplateCreateSchema,
} from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

it('protects the built-in layout, enforces one default, and blocks assigned deletion', async () => {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	try {
		const repo = new Repository(database.db);
		const builtin = (await repo.guideTemplates.list())[0]!;
		expect(builtin).toMatchObject({
			...BUILTIN_GUIDE_TEMPLATE,
			isBuiltin: true,
			isDefault: true,
		});
		const draft = guideTemplateCreateSchema.parse({
			name: 'Client XMLTV',
			description: '  Plex  ',
			sources: { ...BUILTIN_GUIDE_TEMPLATE.sources, episode: '<programme>{{ title }}</programme>' },
		});
		await expect(repo.guideTemplates.save(draft, builtin.id)).rejects.toThrow('cannot be edited');
		await expect(repo.guideTemplates.delete(builtin.id)).rejects.toThrow('cannot be deleted');
		const copy = await repo.guideTemplates.save(draft);
		expect(copy).toMatchObject({ isBuiltin: false, isDefault: false, description: 'Plex' });
		expect(copy.sources.episode).toContain('{{ title }}');
		expect(copy.sources.movie).toBe(BUILTIN_GUIDE_TEMPLATE.sources.movie);
		await repo.guideTemplates.setDefault(copy.id);
		expect((await repo.guideTemplates.getDefault()).id).toBe(copy.id);
		await expect(repo.guideTemplates.delete(copy.id)).rejects.toThrow('Choose another default');
		await repo.guideTemplates.setDefault(builtin.id);
		const channel = await repo.createChannel(channelCreateSchema.parse({
			number: '12',
			name: 'Assigned',
			guideTemplateId: copy.id,
		}));
		await expect(repo.guideTemplates.delete(copy.id)).rejects.toThrow('used by channel Assigned');
		await repo.updateChannel(channel.id, { guideTemplateId: null });
		await repo.guideTemplates.delete(copy.id);
		expect((await repo.guideTemplates.list()).map((entry) => entry.id)).toEqual([builtin.id]);
	}
	finally {
		database.close();
	}
});
