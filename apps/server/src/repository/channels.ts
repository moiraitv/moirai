import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Channel, ChannelCreate, ChannelUpdate } from '@moirai/shared';
import { canonicalChannelNumberKey, effectiveChannelTvgId } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { channels } from '../db/schema.js';
import { ResourceIdentityConflictError } from './resource-identity.js';
import { currentTimestamp } from '../time.js';

/**
 * Own persisted channel identity, presentation, normalization, and logo references. This repository
 * enforces canonical channel-number uniqueness and keeps derived XMLTV identity synchronized with
 * authored channel changes.
 */
export class ChannelRepository {
	constructor(private readonly db: MoiraiDatabase) {}

	/** List channels in channel-number order. */
	async listChannels(): Promise<Channel[]> {
		const rows = await this.db.select().from(channels).orderBy(asc(channels.number));
		return rows.map((row) => ({
			...row.config,
			id: row.id,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		}));
	}

	/** Return a channel by identifier. */
	async getChannel(id: string): Promise<Channel | null> {
		const [row] = await this.db.select().from(channels).where(eq(channels.id, id));
		return row
			? { ...row.config, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt }
			: null;
	}

	/** Return a channel by its canonicalized public number. */
	async getChannelByNumber(number: string): Promise<Channel | null> {
		const [row] = await this.db
			.select()
			.from(channels)
			.where(eq(channels.numberKey, canonicalChannelNumberKey(number)));
		return row
			? { ...row.config, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt }
			: null;
	}

	/** Create a channel with its stable Moirai XMLTV identifier. */
	async createChannel(input: ChannelCreate): Promise<Channel> {
		const timestamp = currentTimestamp();
		const id = randomUUID();
		const effectiveTvgId = effectiveChannelTvgId({ id, number: input.number });
		const numberKey = canonicalChannelNumberKey(input.number);

		this.db.transaction((tx) => {
			const numberConflict = tx
				.select({ id: channels.id })
				.from(channels)
				.where(eq(channels.numberKey, numberKey))
				.get();
			if (numberConflict) {
				throw new ResourceIdentityConflictError('channel-number');
			}

			tx.insert(channels)
				.values({
					id,
					number: input.number,
					numberKey,
					name: input.name,
					effectiveTvgId,
					config: input,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();
		});

		return (await this.getChannel(id))!;
	}

	/** Merge channel changes and refresh the derived Moirai XMLTV identifier. */
	async updateChannel(id: string, input: ChannelUpdate): Promise<Channel | null> {
		const current = await this.getChannel(id);
		if (!current) {
			return null;
		}

		const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...currentConfig } = current;
		void _id;
		void _createdAt;
		void _updatedAt;
		const config = { ...currentConfig, ...input } as ChannelCreate;
		const effectiveTvgId = effectiveChannelTvgId({ id, number: config.number });
		const numberKey = canonicalChannelNumberKey(config.number);

		this.db.transaction((tx) => {
			const numberConflict = tx
				.select({ id: channels.id })
				.from(channels)
				.where(and(eq(channels.numberKey, numberKey), sql`${channels.id} <> ${id}`))
				.get();
			if (numberConflict) {
				throw new ResourceIdentityConflictError('channel-number');
			}

			tx.update(channels)
				.set({
					number: config.number,
					numberKey,
					name: config.name,
					effectiveTvgId,
					config,
					updatedAt: currentTimestamp(),
				})
				.where(eq(channels.id, id))
				.run();
		});

		return this.getChannel(id);
	}

	/** Replace only the logo reference using a channel already fetched by the request. */
	async updateChannelLogo(channel: Channel, logo: string | null): Promise<Channel> {
		const { id, createdAt, updatedAt: _updatedAt, ...currentConfig } = channel;
		void _updatedAt;
		const updatedAt = currentTimestamp();
		const config = { ...currentConfig, logo } as ChannelCreate;
		await this.db.update(channels).set({ config, updatedAt }).where(eq(channels.id, id));
		return { ...config, id, createdAt, updatedAt };
	}

	/** Remove a channel and report whether it existed. */
	async deleteChannel(id: string): Promise<boolean> {
		const result = await this.db.delete(channels).where(eq(channels.id, id));
		return result.changes > 0;
	}
}
