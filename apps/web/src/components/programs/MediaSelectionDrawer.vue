<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { Asterisk, Layers3, Trash2, X } from '@lucide/vue';
import type { MediaGroup, MediaItem } from '@moirai/shared';
import LoadingState from '../LoadingState.vue';
import { requestConfirmation } from '../../confirmation';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import { mediaGroupSubtitle, mediaItemSubtitle } from '../../media-labels';
import MediaCardPreview from '../MediaCardPreview.vue';

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
}>();
const emit = defineEmits<{
	close: [];
	clear: [];
	removeItem: [id: string];
	removeGroup: [id: string];
	'update:search': [value: string];
}>();
const drawer = ref<HTMLElement>();

/** Close the confirmation and clear every selected reference. */
async function confirmClear(): Promise<void> {
	const groups = props.selectingGroups;
	if (await requestConfirmation({
		key: groups ? 'clear-selected-media-groups' : 'clear-selected-media',
		title: groups ? 'Clear Selected Media Groups?' : 'Clear Selected Media?',
		message: groups
			? 'Remove every selected media group from this program?'
			: 'Remove every selected media item from this program?',
		confirmLabel: 'Clear All',
		destructive: true,
	})) {
		emit('clear');
	}
}

onMounted(async () => {
	await nextTick();
	drawer.value?.focus();
});
</script>

<template>
	<Teleport to="body">
		<div class="selection-drawer-backdrop" @click.self="emit('close')">
			<aside
				ref="drawer"
				class="selection-drawer"
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
					<button type="button" aria-label="Close selection" @click="emit('close')">
						<X :size="21" />
					</button>
				</header>
				<div class="selection-drawer-toolbar">
					<input
						:value="search"
						type="search"
						aria-label="Search selected media"
						placeholder="Search selected items…"
						@input="emit('update:search', ($event.target as HTMLInputElement).value)"
					/>
				</div>
				<div class="selection-drawer-content">
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
							{{ selectingGroups ? missingGroupCount : missingItemCount }} selected
							{{ selectingGroups ? 'media group' : 'item' }} reference(s) no longer indexed.
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
								<button
									type="button"
									:aria-label="`Remove ${group.title}`"
									@click="emit('removeGroup', group.id)"
								>
									<X :size="15" />
								</button>
							</article>
						</div>
						<div v-else-if="!selectingGroups && items.length" class="selected-item-grid">
							<MediaCardPreview v-for="item in items" :key="item.id" :item="item" class="selected-item-preview">
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
									</span>
									<span class="selected-item-copy">
										<strong>{{ item.title }}</strong>
										<small>{{ mediaItemSubtitle(libraryType, item) || item.kind }}</small>
										<small v-if="item.availability !== 'available'" class="availability-warning">
											Temporarily unavailable
										</small>
									</span>
									<button
										type="button"
										:aria-label="`Remove ${item.title}`"
										@click="emit('removeItem', item.id)"
									>
										<X :size="15" />
									</button>
								</article>
							</MediaCardPreview>
						</div>
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
					<button
						type="button"
						class="toolbar-button danger-button"
						:disabled="selectionCount === 0"
						@click="confirmClear"
					>
						<Trash2 :size="16" />Clear All
					</button>
					<button type="button" class="button" @click="emit('close')">Done</button>
				</footer>
			</aside>
		</div>
	</Teleport>
</template>
