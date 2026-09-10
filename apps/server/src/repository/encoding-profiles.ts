import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { canonicalIdentityKey, type ChannelCreate, type EncodingProfile, type EncodingProfileCreate } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { channels, encodingProfiles } from '../db/schema.js';
import { currentTimestamp } from '../time.js';

/** A profile conflict or invalid reference safe to display to administrators. */
export class EncodingProfileError extends Error {
	constructor(message: string, readonly statusCode = 409) {
		super(message);
	}
}

/** Resolve an assigned profile during a channel write; ordinary playback reads need no joins. */
export function applyEncodingProfile(db: Pick<MoiraiDatabase, 'select'>, config: ChannelCreate): ChannelCreate {
	if (!config.encodingProfileId) {
		return config;
	}
	const profile = db.select().from(encodingProfiles).where(eq(encodingProfiles.id, config.encodingProfileId)).get();
	if (!profile) {
		throw new EncodingProfileError('Selected encoding profile does not exist', 400);
	}
	return { ...config, audio: profile.config.audio, video: profile.config.video };
}

/** Apply the saved default to a new channel within its creation transaction. */
export function applyDefaultEncodingProfile(db: Pick<MoiraiDatabase, 'select'>, config: ChannelCreate): ChannelCreate {
	const profile = db.select().from(encodingProfiles).where(eq(encodingProfiles.isDefault, true)).get();
	if (!profile) {
		throw new EncodingProfileError('Default encoding profile is unavailable', 503);
	}
	return { ...config, encodingProfileId: profile.id, audio: profile.config.audio, video: profile.config.video };
}

/**
 * Own reusable encoding settings and their channel references. Profile edits atomically refresh
 * linked channel snapshots, keeping playback reads unchanged and Custom channels independent.
 */
export class EncodingProfileRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List named profiles in display order. */
	async list(): Promise<EncodingProfile[]> {
		return this.db.select().from(encodingProfiles).orderBy(asc(encodingProfiles.nameKey)).all()
			.map((row) => ({ ...row.config, id: row.id, isBuiltin: row.isBuiltin, isDefault: row.isDefault, createdAt: row.createdAt, updatedAt: row.updatedAt }))
			.sort((left, right) => Number(right.isBuiltin) - Number(left.isBuiltin)
				|| (left.isBuiltin && right.isBuiltin ? (left.video.height ?? 0) - (right.video.height ?? 0) : left.name.localeCompare(right.name)));
	}

	/** Save a profile and refresh linked channels when its encoding settings change. */
	async save(input: EncodingProfileCreate, id?: string): Promise<{ profile: EncodingProfile; channelIds: string[] }> {
		return this.db.transaction((tx) => {
			const current = id ? tx.select().from(encodingProfiles).where(eq(encodingProfiles.id, id)).get() : undefined;
			if (id && !current) {
				throw new EncodingProfileError('Encoding profile not found', 404);
			}
			if (current?.isBuiltin) {
				throw new EncodingProfileError('Built-in presets cannot be edited; duplicate one to customize it');
			}
			const nameKey = canonicalIdentityKey(input.name);
			const conflict = tx.select().from(encodingProfiles).where(eq(encodingProfiles.nameKey, nameKey)).get();
			if (conflict && conflict.id !== id) {
				throw new EncodingProfileError('An encoding profile with that name already exists');
			}

			const updatedAt = currentTimestamp();
			const profile = { ...input, isBuiltin: false, isDefault: current?.isDefault ?? false, id: id ?? randomUUID(), createdAt: current?.createdAt ?? updatedAt, updatedAt };
			const row = { id: profile.id, name: input.name, nameKey, config: input, createdAt: profile.createdAt, updatedAt };
			if (id) {
				tx.update(encodingProfiles).set(row).where(eq(encodingProfiles.id, id)).run();
			}
			else {
				tx.insert(encodingProfiles).values(row).run();
			}

			// Update only inherited fields, preserving each channel's presentation and playback choices.
			const settingsChanged = current && (JSON.stringify(current.config.audio) !== JSON.stringify(input.audio)
				|| JSON.stringify(current.config.video) !== JSON.stringify(input.video));
			const changed = settingsChanged ? tx.update(channels).set({
				config: sql`json_set(${channels.config}, '$.audio', json(${JSON.stringify(input.audio)}), '$.video', json(${JSON.stringify(input.video)}))`,
				updatedAt,
			}).where(sql`json_extract(${channels.config}, '$.encodingProfileId') = ${id}`).returning({ id: channels.id }).all() : [];
			return { profile, channelIds: changed.map((channel) => channel.id) };
		});
	}

	/** Atomically switch the default for future channels without changing existing assignments. */
	async setDefault(id: string): Promise<EncodingProfile> {
		return this.db.transaction((tx) => {
			const row = tx.select().from(encodingProfiles).where(eq(encodingProfiles.id, id)).get();
			if (!row) {
				throw new EncodingProfileError('Encoding profile not found', 404);
			}
			tx.update(encodingProfiles).set({ isDefault: false }).where(eq(encodingProfiles.isDefault, true)).run();
			tx.update(encodingProfiles).set({ isDefault: true }).where(eq(encodingProfiles.id, id)).run();
			return { ...row.config, id, isBuiltin: row.isBuiltin, isDefault: true, createdAt: row.createdAt, updatedAt: row.updatedAt };
		});
	}

	/** Reject deletion until all linked channels have chosen another profile or Custom. */
	async delete(id: string): Promise<void> {
		this.db.transaction((tx) => {
			const profile = tx.select().from(encodingProfiles).where(eq(encodingProfiles.id, id)).get();
			if (profile?.isBuiltin || profile?.isDefault) {
				throw new EncodingProfileError(profile.isBuiltin ? 'Built-in presets cannot be deleted' : 'Choose another default before deleting this profile');
			}
			const linked = tx.select({ name: channels.name }).from(channels)
				.where(sql`json_extract(${channels.config}, '$.encodingProfileId') = ${id}`).limit(1).get();
			if (linked) {
				throw new EncodingProfileError(`Encoding profile is used by channel ${linked.name}`);
			}
			if (!tx.delete(encodingProfiles).where(eq(encodingProfiles.id, id)).run().changes) {
				throw new EncodingProfileError('Encoding profile not found', 404);
			}
		});
	}
}
