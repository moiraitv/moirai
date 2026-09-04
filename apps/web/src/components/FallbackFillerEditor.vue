<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Trash2, Upload, Video } from '@lucide/vue';
import {
	FALLBACK_FILLER_MAX_BYTES,
	MEDIA_EXTENSIONS,
	type FallbackFillerStatus,
} from '@moirai/shared';
import TwoStepActionButton from './TwoStepActionButton.vue';

/** Props for a staged managed playback-fallback picker. */
interface FallbackFillerEditorProps {
	status: FallbackFillerStatus | null;
	heading?: string;
	removalSource?: string;
	loading?: boolean;
	disabled?: boolean;
}

const props = withDefaults(defineProps<FallbackFillerEditorProps>(), {
	heading: 'Playback fallback filler',
	removalSource: 'Inherited fallback after save',
	loading: false,
	disabled: false,
});
const selectedFile = defineModel<File | null>('selectedFile', { required: true });
const removeOnSave = defineModel<boolean>('removeOnSave', { required: true });
const emit = defineEmits<{ validationError: [message: string] }>();
const input = ref<HTMLInputElement>();
const objectUrl = ref<string | null>(null);
const acceptedExtensions = MEDIA_EXTENSIONS.join(',');

/** Return compact binary file sizes for existing and staged fallback assets. */
function fileSize(value: number): string {
	const units = ['B', 'KiB', 'MiB', 'GiB'];
	let amount = value;
	let unit = 0;
	while (amount >= 1024 && unit < units.length - 1) {
		amount /= 1024;
		unit += 1;
	}
	return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Return a concise elapsed duration for validated server metadata. */
function duration(value: number): string {
	const seconds = Math.round(value / 1_000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** Select the persisted asset represented by the current draft state. */
const displayedAsset = computed(() => removeOnSave.value
	? props.status?.inherited
	: props.status?.effective);

/** Select the staged browser object or persisted server preview. */
const previewUrl = computed(() => {
	if (objectUrl.value) {
		return objectUrl.value;
	}
	const asset = displayedAsset.value;
	return asset
		? `${asset.previewUrl}?v=${encodeURIComponent(asset.updatedAt ?? asset.filename)}`
		: null;
});

/** Human-readable source of the currently displayed effective fallback. */
const sourceLabel = computed(() => {
	if (selectedFile.value) {
		return 'Pending upload';
	}
	if (removeOnSave.value) {
		return props.removalSource;
	}
	if (props.status?.effective.source === 'channel') {
		return 'Channel override';
	}
	if (props.status?.effective.source === 'global') {
		return 'Global override';
	}
	return props.status ? 'Bundled Moirai fallback' : 'Unavailable';
});

/** Validate and retain one browser-selected fallback without uploading it yet. */
function selectFile(event: Event): void {
	const target = event.target as HTMLInputElement;
	const file = target.files?.[0];
	if (!file) {
		return;
	}
	const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
	if (!(MEDIA_EXTENSIONS as readonly string[]).includes(extension)) {
		emit('validationError', 'Choose a supported video file.');
		target.value = '';
		return;
	}
	if (file.size > FALLBACK_FILLER_MAX_BYTES) {
		emit('validationError', 'Fallback filler cannot exceed 512 MiB.');
		target.value = '';
		return;
	}
	emit('validationError', '');
	selectedFile.value = file;
	removeOnSave.value = false;
}

/** Mark the selected or persisted override for removal when its owner is saved. */
function removeFallback(): void {
	emit('validationError', '');
	selectedFile.value = null;
	removeOnSave.value = Boolean(props.status?.overrideConfigured);
	if (input.value) {
		input.value.value = '';
	}
}

watch(selectedFile, (file) => {
	if (objectUrl.value) {
		URL.revokeObjectURL(objectUrl.value);
	}
	if (!file && input.value) {
		input.value.value = '';
	}
	objectUrl.value = file ? URL.createObjectURL(file) : null;
}, { immediate: true });

onBeforeUnmount(() => {
	if (objectUrl.value) {
		URL.revokeObjectURL(objectUrl.value);
	}
});
</script>

<template>
	<div class="fallback-filler-editor">
		<div class="fallback-filler-heading">
			<span>{{ heading }}</span>
			<small>{{ sourceLabel }}</small>
		</div>
		<input
			ref="input"
			class="visually-hidden"
			type="file"
			:accept="acceptedExtensions"
			:disabled="disabled"
			@change="selectFile"
		/>
		<div v-if="loading" class="fallback-filler-loading">Loading fallback media…</div>
		<div v-else class="fallback-filler-content">
			<div class="fallback-filler-preview">
				<video v-if="previewUrl" :src="previewUrl" muted controls preload="metadata"></video>
				<Video v-else :size="36" />
			</div>
			<div class="fallback-filler-details">
				<template v-if="selectedFile">
					<strong>{{ selectedFile.name }}</strong>
					<small>{{ fileSize(selectedFile.size) }} · Video and audio will be checked on save</small>
				</template>
				<template v-else-if="displayedAsset">
					<strong>{{ displayedAsset.filename }}</strong>
					<small>
						{{ fileSize(displayedAsset.fileSizeBytes) }} ·
						{{ duration(displayedAsset.durationMilliseconds) }} ·
						{{ displayedAsset.hasAudio ? 'Includes audio' : 'Silence will be synthesized' }}
					</small>
				</template>
				<template v-else>
					<strong>Fallback unavailable</strong>
					<small>Retry loading before saving this fallback setting.</small>
				</template>
				<p v-if="status?.overrideError" class="notice warning">{{ status.overrideError }}</p>
				<div class="fallback-filler-actions">
					<button type="button" class="button secondary" :disabled="disabled" @click="input?.click()">
						<Upload :size="16" />{{ selectedFile || status?.overrideConfigured ? 'Choose Another' : 'Choose Video' }}
					</button>
					<TwoStepActionButton
						v-if="selectedFile || status?.overrideConfigured"
						class="icon-button danger-text"
						label="Remove fallback filler override"
						confirm-label="Confirm remove fallback filler override"
						:disabled="disabled"
						@confirm="removeFallback"
					>
						<Trash2 :size="17" />
					</TwoStepActionButton>
				</div>
			</div>
		</div>
	</div>
</template>
