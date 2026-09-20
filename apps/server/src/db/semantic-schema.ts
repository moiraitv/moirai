import { blob, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { channels, mediaItems, schedulingPrograms } from './schema.js';

/** Cached vectors are valid only for the recorded model and semantic-input identity. */
export const mediaEmbeddings = sqliteTable('media_embeddings', {
	mediaId: text('media_id').primaryKey().references(() => mediaItems.id, { onDelete: 'cascade' }),
	modelId: text('model_id').notNull(), modelRevision: text('model_revision').notNull(),
	inputVersion: integer('input_version').notNull(), inputHash: text('input_hash').notNull(),
	dimensions: integer('dimensions').notNull(), embedding: blob('embedding', { mode: 'buffer' }),
	generatedAt: text('generated_at'), status: text('status').notNull(), errorCode: text('error_code'),
});

/** Immutable decisions survive timeline rewinds, metadata changes, and missing media. */
export const similaritySeeds = sqliteTable('similarity_seeds', {
	consumerKey: text('consumer_key').notNull(), generation: integer('generation').notNull(),
	programId: text('program_id').notNull().references(() => schedulingPrograms.id, { onDelete: 'cascade' }),
	channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
	sourceItemIds: text('source_item_ids').notNull(), config: text('config').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.consumerKey, table.generation] }), index('similarity_seeds_channel_idx').on(table.channelId)]);

/** Ordinals and media identities cannot be removed by catalog cleanup. */
export const similaritySeedItems = sqliteTable('similarity_seed_items', {
	consumerKey: text('consumer_key').notNull(), generation: integer('generation').notNull(),
	mediaId: text('media_id').notNull(), ordinal: integer('ordinal').notNull(),
}, (table) => [
	primaryKey({ columns: [table.consumerKey, table.generation, table.ordinal] }),
	uniqueIndex('similarity_seed_items_media_unique').on(table.consumerKey, table.generation, table.mediaId),
	foreignKey({ columns: [table.consumerKey, table.generation], foreignColumns: [similaritySeeds.consumerKey, similaritySeeds.generation] }).onDelete('cascade'),
]);

/** Bounded prompt cache keyed by text and immutable inference identity. */
export const semanticPreferences = sqliteTable('semantic_preferences', {
	inputHash: text('input_hash').primaryKey(), inputText: text('input_text').notNull(),
	embedding: blob('embedding', { mode: 'buffer' }), status: text('status').notNull(),
	generatedAt: text('generated_at'), errorCode: text('error_code'),
});
