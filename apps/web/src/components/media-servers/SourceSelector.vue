<script setup lang="ts">
import { computed } from 'vue';
import { Folder } from '@lucide/vue';
import type { MediaServerProvider } from '@moirai/shared';

/** Source variants supported by the library editor's keyboard-selectable source control. */
type Source = 'on-disk' | MediaServerProvider;
/** Display order follows the editor design and remains stable across provider changes. */
const sources: Array<{ id: Source; label: string }> = [
	{ id: 'on-disk', label: 'Folder' }, { id: 'jellyfin', label: 'Jellyfin' },
	{ id: 'plex', label: 'Plex' }, { id: 'emby', label: 'Emby' },
];
const props = withDefaults(defineProps<{ value: string; includeFolder?: boolean; disabled?: boolean }>(), { includeFolder: true, disabled: false });
const emit = defineEmits<{ select: [source: Source] }>();
const options = computed(() => sources.filter((source) => props.includeFolder || source.id !== 'on-disk'));

/** Move both selection and focus using the standard radio-group keyboard pattern. */
function navigate(event: KeyboardEvent, index: number): void {
	const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
	if (props.disabled || (!offset && event.key !== 'Home' && event.key !== 'End')) {
		return;
	}

	event.preventDefault();
	const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.value.length - 1 : (index + offset + options.value.length) % options.value.length;
	emit('select', options.value[next]!.id);
	const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
	buttons?.[next]?.focus();
}
</script>
<template>
	<div class="source-editor-sources" role="radiogroup" :aria-label="includeFolder ? 'Library source' : 'Server provider'">
		<button v-for="(source, index) in options" :key="source.id" type="button" role="radio" :aria-checked="value === source.id" :tabindex="value === source.id ? 0 : -1" :disabled="disabled" :class="{ active: value === source.id }" @click="emit('select', source.id)" @keydown="navigate($event, index)">
			<Folder v-if="source.id === 'on-disk'" :size="30" aria-hidden="true" />
			<svg v-else-if="source.id === 'jellyfin'" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 4C17 4 4 27 5 31s29 4 30 0S23 4 20 4Z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" /><path d="m20 16-6 11h12Z" fill="currentColor" /></svg>
			<svg v-else-if="source.id === 'plex'" viewBox="0 0 40 40" aria-hidden="true"><path d="M10 4h11l11 16-11 16H10l11-16Z" fill="currentColor" /></svg>
			<svg v-else viewBox="0 0 40 40" aria-hidden="true"><path d="m20 2 18 18-18 18L2 20Z" fill="currentColor" /><path d="m17 11 12 9-12 9Z" fill="var(--panel)" /></svg>
			{{ source.label }}
		</button>
	</div>
</template>
