<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, useId, watch } from 'vue';
import { Asterisk, RotateCcw, Trash2, X } from '@lucide/vue';
import { MAX_EXCLUDED_MEDIA_ITEMS, type ProgramConfig, type SemanticMatchesResponse } from '@moirai/shared';
import { api } from '../../api';
import { errorMessage } from '../../error-message';
import { artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import LoadingState from '../LoadingState.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import MediaCardPreview from '../MediaCardPreview.vue';

const props = defineProps<{
	libraryId: string;
	itemIds?: string[];
	config?: Extract<ProgramConfig, { type: 'similarity' | 'theme' }> | undefined;
}>();
const excludedItemIds = defineModel<string[]>('excludedItemIds', { required: true });
const emit = defineEmits<{ close: []; removeItem: [id: string]; clear: [] }>();
const drawer = ref<HTMLElement>();
const content = ref<HTMLElement>();
const visible = ref(true);
const tab = ref<'matches' | 'removed'>('matches');
const tabPrefix = useId();
const search = ref('');
const page = ref(0);
const cursors = ref<Array<string | null>>([null]);
const baselineExcludedItemIds = ref<string[]>([]);
const nextCursor = ref<string | null>(null);
const total = ref(0);
const loading = ref(true);
const loaded = ref(false);
const failure = ref('');
const actionError = ref('');
const pending = ref(false);
const preparationFailed = ref(false);
const message = ref('');
const items = ref<Array<Omit<SemanticMatchesResponse['items'][number], 'availability'> & { availability: string; missing?: boolean }>>([]);
const ai = computed(() => props.itemIds !== undefined);
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: AbortController | undefined;

/** Close the presentation; all changes remain in the owning program draft. */
function close(): void {
	visible.value = false;
}

/** Activate review tabs with the same arrow, Home, and End navigation as settings tabs. */
function navigateTabs(event: KeyboardEvent): void {
	let next = tab.value;
	if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
		next = tab.value === 'matches' ? 'removed' : 'matches';
	}
	else if (event.key === 'Home') {
		next = 'matches';
	}
	else if (event.key === 'End') {
		next = 'removed';
	}
	else {
		return;
	}

	event.preventDefault();
	tab.value = next;
	document.getElementById(`${tabPrefix}-${next}`)?.focus({ preventScroll: true });
}

/** Load a bounded page, discarding responses superseded by draft or navigation changes. */
async function load(): Promise<void> {
	const current = ++revision;
	active?.abort();
	const controller = new AbortController();
	active = controller;
	loading.value = true;
	loaded.value = false;
	failure.value = '';
	pending.value = false;
	preparationFailed.value = false;
	message.value = '';
	try {
		if (tab.value === 'matches' && props.config) {
			const baseline = new Set(baselineExcludedItemIds.value);
			const result = await api.semanticMatches({ config: { ...props.config, excludedItemIds: baselineExcludedItemIds.value },
				additionalExcludedItemIds: excludedItemIds.value.filter((id) => !baseline.has(id)), search: search.value,
				cursor: cursors.value[page.value] ?? null, limit: 100 }, controller.signal);
			if (current !== revision) {
				return;
			}
			items.value = result.items;
			total.value = result.total;
			nextCursor.value = result.nextCursor;
			pending.value = result.pending;
			preparationFailed.value = result.preparationFailed;
			message.value = result.message;
		}
		else {
			const ids = tab.value === 'removed' ? excludedItemIds.value : props.itemIds ?? [];
			const media = ids.length && props.libraryId ? await api.mediaSelection(props.libraryId, ids) : [];
			if (current !== revision) {
				return;
			}
			const byId = new Map(media.map((item) => [item.id, item]));
			const query = search.value.trim().toLocaleLowerCase();
			const matches = ids.map((id) => byId.get(id) ?? { id, libraryId: props.libraryId,
				title: `No longer indexed · ${id}`, year: null, artworkUrl: null, availability: 'missing', missing: true })
				.filter((item) => `${item.title} ${item.year ?? ''}`.toLocaleLowerCase().includes(query));
			total.value = matches.length;
			const offset = Number(cursors.value[page.value] ?? 0);
			items.value = matches.slice(offset, offset + 100);
			nextCursor.value = offset + 100 < matches.length ? String(offset + 100) : null;
		}
		loaded.value = true;
	}
	catch (cause) {
		if (current === revision && !controller.signal.aborted) {
			failure.value = errorMessage(cause);
		}
	}
	finally {
		if (current === revision) {
			loading.value = false;
		}
	}
}

/** Remove one displayed card while retaining the scroll position and adjusted page offsets. */
async function removeCard(id: string): Promise<void> {
	const index = items.value.findIndex((item) => item.id === id);
	if (index < 0) {
		return;
	}
	const scrollTop = content.value?.scrollTop ?? 0;
	const removedOffset = Number(cursors.value[page.value] ?? 0) + index;
	const shift = (cursor: string | null): string | null => cursor !== null && Number(cursor) > removedOffset
		? String(Number(cursor) - 1) : cursor;
	cursors.value = cursors.value.map(shift);
	nextCursor.value = shift(nextCursor.value);
	items.value = items.value.filter((item) => item.id !== id);
	total.value -= 1;
	await nextTick();
	const controls = content.value?.querySelectorAll<HTMLButtonElement>('.selected-item-grid article > button');
	(controls?.[index] ?? controls?.[Math.max(0, index - 1)])?.focus({ preventScroll: true });
	if (content.value) {
		content.value.scrollTop = scrollTop;
	}
}

/** Retain one explicit removal, leaving ordinary collection removal behavior untouched. */
function remove(id: string): void {
	if (excludedItemIds.value.length >= MAX_EXCLUDED_MEDIA_ITEMS) {
		actionError.value = `At most ${MAX_EXCLUDED_MEDIA_ITEMS.toLocaleString()} removed items can be retained. Restore an item first.`;
		return;
	}

	excludedItemIds.value = [...new Set([...excludedItemIds.value, id])];
	emit('removeItem', id);
	void removeCard(id);
}

/** Clear the current AI selection only when every removal can be retained. */
function clear(): void {
	const ids = [...new Set([...excludedItemIds.value, ...props.itemIds ?? []])];
	if (ids.length > MAX_EXCLUDED_MEDIA_ITEMS) {
		actionError.value = `At most ${MAX_EXCLUDED_MEDIA_ITEMS.toLocaleString()} removed items can be retained. Restore items first.`;
		return;
	}

	excludedItemIds.value = ids;
	emit('clear');
	items.value = [];
	total.value = 0;
	page.value = 0;
	cursors.value = [null];
	nextCursor.value = null;
}

/** Restore future matching eligibility without inserting an AI item into its frozen selection. */
function restore(id: string): void {
	excludedItemIds.value = excludedItemIds.value.filter((candidate) => candidate !== id);
	actionError.value = '';
	void removeCard(id);
}

/** Move between pages without transferring the full semantic matching pool to the browser. */
function move(offset: -1 | 1): void {
	if (offset > 0 && nextCursor.value) {
		cursors.value[page.value + 1] = nextCursor.value;
	}
	page.value += offset;
	void load();
}

// Local removals update cards and offsets directly; only a different review scope starts over.
watch(() => JSON.stringify([props.config ? { ...props.config, excludedItemIds: undefined } : undefined,
	props.libraryId, tab.value, search.value]), () => {
	revision += 1;
	active?.abort();
	clearTimeout(timer);
	page.value = 0;
	cursors.value = [null];
	loading.value = true;
	loaded.value = false;
	baselineExcludedItemIds.value = [...excludedItemIds.value];
	timer = setTimeout(() => void load(), 250);
}, { immediate: true, flush: 'sync' });
onMounted(async () => {
	await nextTick();
	drawer.value?.focus();
});
onScopeDispose(() => {
	revision += 1;
	clearTimeout(timer);
	active?.abort();
});
</script>

<template>
	<Teleport to="body">
		<Transition name="selection-drawer" appear @after-leave="emit('close')">
			<div v-show="visible" class="selection-drawer-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close">
				<aside ref="drawer" v-modal-focus="{ escape: close }" class="selection-drawer media-selection-drawer program-matches-drawer" role="dialog" aria-modal="true" aria-labelledby="matches-drawer-title" tabindex="-1">
					<header class="selection-drawer-header">
						<div><p class="eyebrow">{{ ai ? 'AI results' : 'Program matches' }}</p><h2 id="matches-drawer-title">{{ ai ? 'Review results' : 'Review matches' }}</h2><p>Changes are kept in your draft. Save the Program to apply them.</p></div>
						<button type="button" aria-label="Close selection" @click="close"><X :size="21" /></button>
					</header>
					<div class="program-matches-toolbar">
						<div class="program-matches-tabs" role="tablist" aria-label="Review items">
							<button :id="`${tabPrefix}-matches`" type="button" role="tab" :aria-selected="tab === 'matches'" :aria-controls="`${tabPrefix}-panel`" :tabindex="tab === 'matches' ? 0 : -1" @click="tab = 'matches'" @keydown="navigateTabs">Matches</button>
							<button :id="`${tabPrefix}-removed`" type="button" role="tab" :aria-selected="tab === 'removed'" :aria-controls="`${tabPrefix}-panel`" :tabindex="tab === 'removed' ? 0 : -1" @click="tab = 'removed'" @keydown="navigateTabs">Removed ({{ excludedItemIds.length }})</button>
						</div>
						<input v-model="search" class="program-matches-search" type="search" aria-label="Search selected media" placeholder="Search items…" maxlength="200" />
					</div>
					<div :id="`${tabPrefix}-panel`" ref="content" class="selection-drawer-content" role="tabpanel" :aria-labelledby="`${tabPrefix}-${tab}`" :aria-busy="loading" tabindex="0">
						<p v-if="tab === 'removed'" class="muted">Restore allows future matching again.<template v-if="ai"> Generate again to include restored items in AI results.</template></p>
						<p v-if="actionError" class="notice warning" role="alert">{{ actionError }}</p>
						<LoadingState v-if="loading" label="Loading selected media…" />
						<div v-else-if="failure" class="notice warning" role="alert">Could not load the selection. {{ failure }} <button type="button" @click="load">Try again</button></div>
						<template v-else-if="loaded">
							<p role="status">{{ total }} {{ tab === 'removed' ? 'removed' : ai ? 'selected' : 'matches' }}</p>
							<p v-if="pending || preparationFailed" class="notice warning" role="status">{{ message }} Review shows prepared matches. <button type="button" @click="load">Refresh</button></p>
							<div v-if="items.length" class="selected-item-grid">
								<MediaCardPreview v-for="item in items" :key="item.id" :item="item" :hide-info="Boolean(item.missing)" class="selected-item-preview">
									<article>
										<span class="selected-item-poster"><span class="source-artwork-placeholder"><Asterisk :size="20" /></span><img v-if="item.artworkUrl" :src="artworkVariantUrl(item.artworkUrl, 'card')" :alt="`${item.title} artwork`" loading="lazy" decoding="async" @error="hideBrokenImage" /></span>
										<span class="selected-item-copy"><strong>{{ item.title }}</strong><small v-if="item.year">{{ item.year }}</small><small v-if="item.availability !== 'available'" class="availability-warning">{{ item.missing ? 'Metadata unavailable' : 'Temporarily unavailable' }}</small></span>
										<button v-if="tab === 'removed'" type="button" class="program-match-restore" :aria-label="`Restore ${item.title}`" @click="restore(item.id)"><RotateCcw :size="15" /> Restore</button>
										<TwoStepActionButton v-else :label="`Exclude ${item.title}`" :confirm-label="`Confirm exclude ${item.title}`" @confirm="remove(item.id)"><Trash2 :size="15" /></TwoStepActionButton>
									</article>
								</MediaCardPreview>
							</div>
							<p v-else-if="!pending && !preparationFailed" class="empty-state compact">{{ tab === 'removed' ? 'No removed items match.' : 'No matching items to display.' }}</p>
							<div v-if="page > 0 || nextCursor" class="program-matches-pages"><button type="button" :disabled="page === 0" @click="move(-1)">Previous</button><span>Page {{ page + 1 }}</span><button type="button" :disabled="!nextCursor" @click="move(1)">Next</button></div>
						</template>
					</div>
					<footer class="selection-drawer-footer">
						<TwoStepActionButton v-if="ai && tab === 'matches'" class="toolbar-button danger-button" :disabled="!itemIds?.length || loading" label="Clear All" confirm-label="Confirm Clear All" confirm-text="Confirm Clear" @confirm="clear"><Trash2 :size="16" />Clear All</TwoStepActionButton>
						<button type="button" class="button secondary program-match-done" @click="close">Done</button>
					</footer>
				</aside>
			</div>
		</Transition>
	</Teleport>
</template>
