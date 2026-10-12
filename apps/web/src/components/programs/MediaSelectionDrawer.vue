<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { Trash2, X } from '@lucide/vue';
import TwoStepActionButton from '../TwoStepActionButton.vue';
import MediaSelectionReview from './MediaSelectionReview.vue';
import type { MediaSelectionProps, MediaSelectionEvents } from './media-selection';

const props = defineProps<MediaSelectionProps>();
const emit = defineEmits<MediaSelectionEvents & { close: [] }>();
const drawer = ref<HTMLElement>();
const visible = ref(true);

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
					v-modal-focus="{ escape: close }"
					class="selection-drawer"
					:class="{ 'media-selection-drawer': !selectingGroups }" role="dialog"
					aria-modal="true"
					aria-labelledby="selection-drawer-title"
					tabindex="-1"
				>
					<header class="selection-drawer-header">
						<div>
							<p class="eyebrow">
								{{ aiSelection ? 'AI results' : selectingGroups ? 'Specific media groups' : 'Specific media items' }}
							</p>
							<h2 id="selection-drawer-title">{{ aiSelection ? 'Review results' : 'Review selection' }}</h2>
							<p>{{ selectionCount }}<template v-if="!aiSelection"> of {{ selectionLimit }}</template> selected</p>
						</div>
						<button type="button" aria-label="Close selection" @click="close">
							<X :size="21" />
						</button>
					</header>
					<MediaSelectionReview
						v-bind="props"
						@retry="emit('retry')" @remove-item="emit('removeItem', $event)" @remove-group="emit('removeGroup', $event)"
						@move-item="(id, offset) => emit('moveItem', id, offset)" @reorder-items="emit('reorderItems', $event)"
						@update:search="emit('update:search', $event)" @update:sort-type="emit('update:sortType', $event)"
						@update:sort-direction="emit('update:sortDirection', $event)"
					/>
					<footer class="selection-drawer-footer">
						<TwoStepActionButton
							class="toolbar-button danger-button"
							:disabled="selectionCount === 0 || loading"
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
