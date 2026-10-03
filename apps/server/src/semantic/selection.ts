import { eligibleFiller, selectFillerCandidate } from '../scheduling/filler-cycle.js';
import { selectOrderedCandidate } from '../scheduling/candidate-selection.js';
import { semanticSource } from './source.js';
import { passesSemanticExclusions, preferenceIssue } from './refinement.js';
import type { SchedulableMedia, SchedulingCatalog, SelectionStateRecord, SimilaritySeed } from '@moirai/shared';
import { MAX_MEDIA_DURATION_MILLISECONDS, SEMANTIC_HISTORY_LIMIT } from '@moirai/shared';
import { addIssue, type SelectionContext, type SelectionFitMode } from '../scheduling/selection.js';
import { rankSemanticCandidates } from './ranking.js';

/** Keep semantic seed progress across daily occurrence cursors, including nested sequences. */
export function semanticConsumerKey(key: string): string {
	return key.replace(/:\d{4}-\d{2}-\d{2}(?=:|$)/u, '');
}

/** Apply ordinary playable-media rules before ranking or consuming semantic entries. */
export function semanticMediaEligible(media: SchedulableMedia, catalog: SchedulingCatalog): boolean {
	const library = catalog.libraryAvailability[media.libraryId];
	return !catalog.semantic?.unavailableItems?.[media.id]
		&& catalog.libraryEnabled?.[media.libraryId] !== false
		&& (library === 'available' || library === 'degraded')
		&& media.availability === 'available'
		&& ['none', 'complete'].includes(media.multipartStatus ?? 'none')
		&& media.durationSeconds !== null && Number.isFinite(media.durationSeconds)
		&& media.durationSeconds > 0
		&& media.durationSeconds * 1_000 <= MAX_MEDIA_DURATION_MILLISECONDS;
}

/** Propose one seed consumption without mutating persisted decisions or the caller's state. */
export function chooseSimilarity(
	programId: string,
	consumer: string,
	state: Map<string, SelectionStateRecord>,
	context: SelectionContext,
	fitSeconds: number | null,
	fitMode: SelectionFitMode = 'best-fit',
): SchedulableMedia | null {
	const program = context.programs.get(programId)!;
	if (program.config.type !== 'similarity' && program.config.type !== 'theme') {
		return null;
	}
	const config = program.config;
	const baseKey = semanticConsumerKey(consumer);
	const key = baseKey.includes(':entry:') ? `${baseKey}:program:${programId}` : baseKey;
	const record = state.get(key);
	const prior = record?.value.type === 'similarity' && record.value.seed.programId === programId ? record.value : null;
	const corpus = context.catalog.semantic;
	const fillerSources = context.fillerSemanticSources ??= new Map();
	if (context.fillerSelection && !fillerSources.has(programId)) {
		const source = semanticSource(config, [...context.programs.values()], context.catalog);
		fillerSources.set(programId, new Set(source.valid ? source.items.map(media => media.id) : []));
	}
	let seed: SimilaritySeed | undefined = prior?.seed;
	let consumed = prior?.consumedItemIds ?? [];
	let recentSeeds = prior?.recentSeeds ?? [];
	const report = (message: string, blocked = true): null => {
		if (blocked) {
			context.blockedPrograms.add(programId);
		}
		addIssue(context, { code: 'source-unavailable', message, programId, mediaItemId: null });
		return null;
	};

	const deferredIds = context.fillerSelection ? prior?.fillerCycle?.remainingItemIds ?? [] : [];
	const refillFiller = Boolean(context.fillerSelection && prior?.fillerCycle && !deferredIds.some(id => {
		const mediaId = context.catalog.mediaAliases?.[id] ?? id;
		const media = context.catalog.mediaById?.get(mediaId) ?? context.catalog.media.find(item => item.id === mediaId);
		return media && fillerSources.get(programId)!.has(media.id) && passesSemanticExclusions(media, config, context.catalog)
			&& semanticMediaEligible(media, context.catalog) && eligibleFiller(media, context);
	}));
	if (!seed || refillFiller || seed.itemIds.every((id) => consumed.includes(id))) {
		const generation = (seed?.generation ?? 0) + 1;
		const previous = seed?.itemIds ?? [];
		seed = corpus?.seeds.find((entry) => entry.consumerKey === key && entry.programId === programId && entry.generation === generation);
		if (!seed) {
			const source = semanticSource(program.config, [...context.programs.values()], context.catalog);
			if (!source.valid) {
				return report(source.missing);
			}
			const refinementIssue = preferenceIssue(program.config, context.catalog);
			if (refinementIssue) {
				return report(refinementIssue);
			}
			const { sourceIds, anchors } = source;
			if (anchors.length === 0) {
				return report('Matching preparation is not ready. Check that the source items are available and Moirai is fully installed.');
			}
			const config = program.config;
			const eligible = source.items.filter((media) => passesSemanticExclusions(media, config, context.catalog) && semanticMediaEligible(media, context.catalog));
			const items = rankSemanticCandidates(anchors, eligible.flatMap((media) => corpus?.vectors[media.id]
				? [{ id: media.id, vector: corpus.vectors[media.id]! }] : []), program.config.quantity, program.config.variety, previous, corpus?.preferences?.[program.config.softPreferences?.trim() ?? '']?.vector, recentSeeds.slice(0, SEMANTIC_HISTORY_LIMIT - 1));
			const pending = new Set(corpus?.pendingItemIds ?? []);
			if (sourceIds.some((id) => pending.has(id))
				|| (items.length < program.config.quantity && eligible.some((media) => pending.has(media.id)))) {
				return report('Preparing matches for the next set.');
			}
			if (!items.length) {
				return report(config.hardExclusions?.length
					? 'No prepared matches remain after exclusions. Try reducing exclusion strictness.'
					: 'No related playable items are ready for matching yet.');
			}
			seed = { programId, consumerKey: key, generation, itemIds: items, sourceItemIds: sourceIds,
				config: structuredClone(program.config), createdAt: context.now };
		}
		recentSeeds = previous.length ? [previous, ...recentSeeds].slice(0, SEMANTIC_HISTORY_LIMIT) : recentSeeds;
		consumed = [];
	}

	if (seed.itemIds.length < seed.config.quantity) {
		report(`Current set contains ${seed.itemIds.length} related items; fewer than the requested quantity are available.`, false);
	}
	const remaining = context.fillerSelection ? [...new Set([...deferredIds, ...seed.itemIds])] : seed.itemIds.filter((id) => !consumed.includes(id));
	const playable = remaining.flatMap((id) => {
		const mediaId = context.catalog.mediaAliases?.[id] ?? id;
		const media = context.catalog.mediaById?.get(mediaId) ?? context.catalog.media.find((item) => item.id === mediaId);
		// Playback follows catalog aliases, but committed membership keeps its original identity.
		return media && semanticMediaEligible(media, context.catalog) && (!context.fillerSelection || (fillerSources.get(programId)!.has(media.id) && passesSemanticExclusions(media, config, context.catalog))) ? [{ id, media }] : [];
	});
	if (playable.length < remaining.length) {
		report('Some remaining items in the current set are unavailable. The set will wait for them.', playable.length === 0);
	}
	// Keep filler membership separate from semantic seed consumption and preserve ranked ordering.
	const proposed: SelectionStateRecord = { consumerKey: key, configFingerprint: 'similarity-v1', updatedAt: context.now,
		value: { type: 'similarity', seed, recentSeeds, consumedItemIds: consumed,
			...(prior?.fillerCycle ? { fillerCycle: prior.fillerCycle } : {}) } };
	const media = context.fillerSelection
		? selectFillerCandidate(playable.map(entry => entry.media), proposed, context, fitSeconds, () => playable.map(entry => entry.media))
		: selectOrderedCandidate(playable.map(entry => entry.media), context, fitSeconds, fitMode, true);
	const selected = media ? playable.find(entry => entry.media === media) : undefined;
	if (!selected) {
		if (playable.length && fitSeconds !== null) {
			context.fitRejectionCount += 1;
		}
		return null;
	}
	if (proposed.value.type === 'similarity') {
		proposed.value.consumedItemIds = [...consumed, selected.id];
	}
	state.set(key, proposed);
	return selected.media;
}
