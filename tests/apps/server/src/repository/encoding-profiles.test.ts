import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { BUILTIN_ENCODING_PROFILES, DEFAULT_ENCODING_PROFILE_ID, channelCreateSchema, encodingProfileCreateSchema } from '@moirai/shared';
import { toEtvChannelConfig } from '@moirai/ersatztv-contract';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) {
		database.close();
	}
});
function repository(): Repository {
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	databases.push(database);
	return new Repository(database.db);
}
function draft(name = 'Shared HD') {
	return encodingProfileCreateSchema.parse({ name, audio: { bitrateKbps: 256 }, video: { width: 1280, height: 720 } });
}

it('applies linked settings to channel reads and next output while preserving independent settings', async () => {
	const repo = repository();
	const { profile } = await repo.encodingProfiles.save(draft());
	const input = channelCreateSchema.parse({ number: '1', name: 'Linked', encodingProfileId: profile.id, subtitleMode: 'convert', subtitleFontsFolder: '/fonts', ffmpegPath: '/ffmpeg', group: 'Music' });
	const linked = await repo.createChannel(input);
	const custom = await repo.createChannel(channelCreateSchema.parse({ number: '2', name: 'Custom', video: { width: 640 } }));
	expect(linked.video.width).toBe(profile.video.width);
	const changed = { ...draft(), video: { ...profile.video, width: 1920, height: 1080 }, audio: { ...profile.audio, bitrateKbps: 320 } };
	const saved = await repo.encodingProfiles.save(changed, profile.id);
	expect(saved.channelIds).toEqual([linked.id]);
	const updated = (await repo.getChannel(linked.id))!;
	expect(updated).toMatchObject({ encodingProfileId: profile.id, subtitleMode: 'convert', subtitleFontsFolder: '/fonts', ffmpegPath: '/ffmpeg', group: 'Music', video: changed.video, audio: changed.audio });
	expect(toEtvChannelConfig({ ...updated, video: { ...updated.video, accel: null } })).toMatchObject({ normalization: { video: { width: 1920, height: 1080 }, audio: { bitrate_kbps: 320 } } });
	expect(await repo.getChannel(custom.id)).toEqual(custom);
	expect((await repo.listChannels()).find((row) => row.id === linked.id)).toEqual(updated);
	expect(await repo.getChannelByNumber('1')).toEqual(updated);
});

it('detaches into Custom without losing effective values and ignores profile-inconsistent channel writes', async () => {
	const repo = repository();
	const { profile } = await repo.encodingProfiles.save(draft());
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Linked', encodingProfileId: profile.id }));
	const stillLinked = await repo.updateChannel(channel.id, { video: { ...channel.video, width: 320 } });
	expect(stillLinked?.video).toEqual(profile.video);
	await repo.updateChannel(channel.id, { encodingProfileId: null });
	await repo.encodingProfiles.save({ ...draft(), video: { ...profile.video, width: 640 } }, profile.id);
	expect(await repo.getChannel(channel.id)).toMatchObject({ encodingProfileId: null, audio: profile.audio, video: profile.video });
	await repo.encodingProfiles.delete(profile.id);
	expect((await repo.encodingProfiles.list()).filter((entry) => !entry.isBuiltin)).toEqual([]);
});

it('protects references and enforces case-insensitive names without partial changes', async () => {
	const repo = repository();
	const { profile } = await repo.encodingProfiles.save(draft());
	await expect(repo.encodingProfiles.save(draft('SHARED HD'))).rejects.toThrow('already exists');
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Linked', encodingProfileId: profile.id }));
	await expect(repo.encodingProfiles.delete(profile.id)).rejects.toThrow('Linked');
	await expect(repo.updateChannel(channel.id, { encodingProfileId: randomUUID(), name: 'Must not persist' })).rejects.toThrow('does not exist');
	expect((await repo.getChannel(channel.id))?.name).toBe('Linked');
	await expect(repo.createChannel(channelCreateSchema.parse({ number: '2', name: 'Invalid', encodingProfileId: randomUUID() }))).rejects.toThrow('does not exist');
	expect(await repo.listChannels()).toHaveLength(1);
});

it('preserves new profile settings when saving a logo from an older channel snapshot', async () => {
	const repo = repository();
	const { profile } = await repo.encodingProfiles.save(draft());
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Linked', encodingProfileId: profile.id }));
	await repo.encodingProfiles.save({ ...draft(), video: { ...profile.video, width: 640 } }, profile.id);
	await repo.updateChannelLogo(channel, 'https://example.test/logo.png');
	expect(await repo.getChannel(channel.id)).toMatchObject({ video: { width: 640 }, logo: 'https://example.test/logo.png' });
});

it('seeds immutable presets and changes the default without changing existing channels', async () => {
	const repo = repository();
	const presets = await repo.encodingProfiles.list();
	expect(presets.filter((profile) => profile.isDefault).map((profile) => profile.id)).toEqual([DEFAULT_ENCODING_PROFILE_ID]);
	for (const expected of BUILTIN_ENCODING_PROFILES) {
		expect(presets.find((profile) => profile.id === expected.id)).toMatchObject({ ...expected, isBuiltin: true });
		await expect(repo.encodingProfiles.delete(expected.id)).rejects.toThrow('cannot be deleted');
		await expect(repo.encodingProfiles.save(expected, expected.id)).rejects.toThrow('cannot be edited');
	}
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Default' }), true);
	expect(channel.encodingProfileId).toBe(DEFAULT_ENCODING_PROFILE_ID);
	const { profile } = await repo.encodingProfiles.save(draft('My default'));
	await repo.encodingProfiles.setDefault(profile.id);
	await expect(repo.encodingProfiles.delete(profile.id)).rejects.toThrow('another default');
	expect(await repo.getChannel(channel.id)).toEqual(channel);
	const next = await repo.createChannel(channelCreateSchema.parse({ number: '2', name: 'Next' }), true);
	expect(next).toMatchObject({ encodingProfileId: profile.id, video: profile.video, audio: profile.audio });
	await expect(repo.encodingProfiles.setDefault(randomUUID())).rejects.toThrow('not found');
	expect((await repo.encodingProfiles.list()).filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual([profile.id]);
});

it('persists descriptions without refreshing channels for metadata-only edits', async () => {
	const repo = repository();
	const { profile } = await repo.encodingProfiles.save(draft());
	const channel = await repo.createChannel(channelCreateSchema.parse({ number: '1', name: 'Linked', encodingProfileId: profile.id }));
	const changed = encodingProfileCreateSchema.parse({ ...draft(), description: '  Music videos  ' });
	const saved = await repo.encodingProfiles.save(changed, profile.id);
	expect(saved.channelIds).toEqual([]);
	expect((await repo.encodingProfiles.list()).find((entry) => entry.id === profile.id)?.description).toBe('Music videos');
	expect(await repo.getChannel(channel.id)).toEqual(channel);
});
