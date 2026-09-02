<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { ChevronLeft, ChevronRight, GripVertical, Asterisk, Layers3, Trash2, X } from '@lucide/vue';
import type { MediaGroup, MediaItem, SelectedMediaSort } from '@moirai/shared';
import { VueDraggable } from 'vue-draggable-plus';
import LoadingState from '../LoadingState.vue';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import MediaCardPreview from '../MediaCardPreview.vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import { countLabel } from '../../count-label';

const props = defineProps<{
	selectingGroups: boolean;
	selectionCount: number;
	selectionLimit: number;
	loading: boolean;
	loaded: boolean;
	missingItemCount: number;
	missingGroupCount: number;
	items: MediaItem[];
	groups: MediaGroup[];
	selectedItemCount: number;
	selectedGroupCount: number;
	itemReferenceCount: number;
	groupReferenceCount: number;
	libraryType: string;
	search: string;
	sort: SelectedMediaSort;
}>();
const emit = defineEmits<{
	close: [];
	clear: [];
	removeItem: [id: string];
	removeGroup: [id: string];
	moveItem: [id: string, offset: -1 | 1];
	reorderItems: [itemIds: string[]];
	'update:search': [value: string];
	'update:sortType': [value: 'date-added' | 'name' | 'release-date' | 'manual'];
	'update:sortDirection': [value: 'asc' | 'desc'];
}>();
const drawer = ref<HTMLElement>();
const drawerContent = ref<HTMLElement>();
const visible = ref(true);
const manual = computed(() => props.sort.type === 'manual');
const filtered = computed(() => props.search.trim().length > 0);
const direction = computed(() => props.sort.type === 'manual' ? 'asc' : props.sort.direction);
const draggableItems = computed({
	get: () => props.items,
	set: (items: MediaItem[]) => emit('reorderItems', items.map((item) => item.id)),
});

/** Describe ascending and descending choices in terms appropriate to the active field. */
function directionLabel(value: 'asc' | 'desc'): string {
	if (props.sort.type === 'name') {
		return value === 'asc' ? 'A–Z' : 'Z–A';
	}

	return value === 'asc' ? 'Oldest First' : 'Newest First';
}

/** Begin closing the drawer while preserving it for the spatial exit transition. */
function close(): void {
	visible.value = false;
}

onMounted(async () => {
	await nextTick();
	drawer.value?.focus();
});
</script>

<template>
	<Teleport to="body">
		<Transition name="selection-drawer" appear @after-leave="emit('close')">
			<div v-show="visible" class="selection-drawer-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="close">
				<aside
					ref="drawer"
					class="selection-drawer"
					:class="{ 'media-selection-drawer': !selectingGroups }"
					role="dialog"
					aria-modal="true"
					aria-labelledby="selection-drawer-title"
					tabindex="-1"
				>
					<header class="selection-drawer-header">
						<div>
							<p class="eyebrow">
								{{ selectingGroups ? 'Specific media groups' : 'Specific media items' }}
							</p>
							<h2 id="selection-drawer-title">Review selection</h2>
							<p>{{ selectionCount }} of {{ selectionLimit }} selected</p>
						</div>
						<button type="button" aria-label="Close selection" @click="close">
							<X :size="21" />
						</button>
					</header>
					<div class="selection-drawer-toolbar" :class="{ 'group-selection-toolbar': selectingGroups }">
						<label>
							<span>Search</span>
							<input
								:value="search"
								type="search"
								aria-label="Search selected media"
								placeholder="Search selected items…"
								@input="emit('update:search', ($event.target as HTMLInputElement).value)"
							/>
						</label>
						<label v-if="!selectingGroups">
							<span>Sort By</span>
							<select
								:value="sort.type"
								:disabled="loading || !loaded"
								aria-label="Sort selected media"
								@change="emit('update:sortType', ($event.target as HTMLSelectElement).value as 'date-added' | 'name' | 'release-date' | 'manual')"
							>
								<option value="date-added">Date Added to Program</option>
								<option value="name">Name</option>
								<option value="release-date">Release Date</option>
								<option value="manual">Manual</option>
							</select>
						</label>
						<label v-if="!selectingGroups && !manual">
							<span>Direction</span>
							<select
								:value="direction"
								:disabled="loading || !loaded"
								aria-label="Selected media sort direction"
								@change="emit('update:sortDirection', ($event.target as HTMLSelectElement).value as 'asc' | 'desc')"
							>
								<option value="asc">{{ directionLabel('asc') }}</option>
								<option value="desc">{{ directionLabel('desc') }}</option>
							</select>
						</label>
						<p v-if="!selectingGroups && manual && filtered" class="manual-order-hint">
							Clear search to reorder selected media.
						</p>
					</div>
					<div ref="drawerContent" class="selection-drawer-content">
						<LoadingState
							v-if="loading && !loaded"
							:label="
								selectingGroups ? 'Loading selected media groups…' : 'Loading selected media…'
							"
						/>
						<template v-else>
							<p
								v-if="selectingGroups ? missingGroupCount > 0 : missingItemCount > 0"
								class="notice warning compact-notice"
							>
								{{ countLabel(
									selectingGroups ? missingGroupCount : missingItemCount,
									selectingGroups ? 'selected media group reference' : 'selected item reference',
								) }} {{ (selectingGroups ? missingGroupCount : missingItemCount) === 1 ? 'is' : 'are' }} no longer indexed.
								Saving preserves these references unless you clear the selection.
							</p>
							<div v-if="selectingGroups && groups.length" class="selected-item-grid">
								<article v-for="group in groups" :key="group.id">
									<span class="selected-item-poster">
										<span class="source-artwork-placeholder"><Layers3 :size="20" /></span>
										<img
											v-if="group.artworkUrl"
											:src="artworkVariantUrl(group.artworkUrl, 'card')"
											:srcset="artworkSrcset(group.artworkUrl, 'card')"
											:alt="`${group.title} artwork`"
											loading="eager"
											decoding="async"
											@error="hideBrokenImage"
										/>
									</span>
									<span class="selected-item-copy">
										<strong>{{ group.title }}</strong>
										<small>{{ mediaGroupSubtitle(libraryType, group) || group.kind }}</small>
									</span>
									<TwoStepActionButton
										:label="`Remove ${group.title}`"
										:confirm-label="`Confirm remove ${group.title}`"
										@confirm="emit('removeGroup', group.id)"
									>
										<X :size="15" />
									</TwoStepActionButton>
								</article>
							</div>
							<VueDraggable
								v-else-if="!selectingGroups && items.length"
								v-model="draggableItems"
								class="selected-item-grid"
								draggable=".selected-item-preview"
								handle=".selected-item-drag-handle"
								:disabled="!manual || filtered"
								:animation="160"
								:scroll="drawerContent ?? true"
								:scroll-sensitivity="72"
								:scroll-speed="12"
								:bubble-scroll="true"
								:force-fallback="true"
								:fallback-on-body="true"
								ghost-class="selected-item-drag-ghost"
								drag-class="selected-item-dragging"
							>
								<MediaCardPreview
									v-for="(item, index) in items"
									:key="item.id"
									:item="item"
									class="selected-item-preview"
									:class="{ 'manual-order-preview': manual }"
								>
									<article>
										<span class="selected-item-poster">
											<span class="source-artwork-placeholder"><Asterisk :size="20" /></span>
											<img
												v-if="item.artworkUrl"
												:src="artworkVariantUrl(item.artworkUrl, 'card')"
												:srcset="artworkSrcset(item.artworkUrl, 'card')"
												:alt="`${item.title} artwork`"
												loading="eager"
												decoding="async"
												@error="hideBrokenImage"
											/>
											<span v-if="manual" class="selected-item-order-controls">
												<button
													type="button"
													class="selected-item-drag-handle"
													:disabled="filtered"
													:aria-label="`Drag ${item.title} to reorder`"
												>
													<GripVertical :size="15" />
												</button>
												<button
													type="button"
													:disabled="filtered || index === 0"
													:aria-label="`Move ${item.title} earlier`"
													@click="emit('moveItem', item.id, -1)"
												>
													<ChevronLeft :size="14" />
												</button>
												<button
													type="button"
													:disabled="filtered || index === items.length - 1"
													:aria-label="`Move ${item.title} later`"
													@click="emit('moveItem', item.id, 1)"
												>
													<ChevronRight :size="14" />
												</button>
											</span>
										</span>
										<span class="selected-item-copy">
											<strong>{{ item.title }}</strong>
											<small>{{ mediaItemSubtitle(libraryType, item) || item.kind }}</small>
											<small v-if="item.availability !== 'available'" class="availability-warning">
												Temporarily unavailable
											</small>
										</span>
										<TwoStepActionButton
											class="selected-item-remove"
											:label="`Remove ${item.title}`"
											:confirm-label="`Confirm remove ${item.title}`"
											@confirm="emit('removeItem', item.id)"
										>
											<X :size="15" />
										</TwoStepActionButton>
									</article>
								</MediaCardPreview>
							</VueDraggable>
							<div v-else class="empty-state compact selection-drawer-empty">
								<p>
									{{
										selectingGroups
											? selectedGroupCount
												? 'No selected media groups match.'
												: groupReferenceCount
													? 'No indexed selected media groups to display.'
													: 'No media groups selected.'
											: selectedItemCount
												? 'No selected items match.'
												: itemReferenceCount
													? 'No indexed selected media to display.'
													: 'No media selected.'
									}}
								</p>
							</div>
						</template>
					</div>
					<footer class="selection-drawer-footer">
						<TwoStepActionButton
							class="toolbar-button danger-button"
							:disabled="selectionCount === 0"
							label="Clear All"
							confirm-label="Confirm Clear All"
							confirm-text="Confirm Clear"
							@confirm="emit('clear')"
						>
							<Trash2 :size="16" />Clear All
						</TwoStepActionButton>
						<button type="button" class="button" @click="close">Done</button>
					</footer>
				</aside>
			</div>
		</Transition>
	</Teleport>
</template>
