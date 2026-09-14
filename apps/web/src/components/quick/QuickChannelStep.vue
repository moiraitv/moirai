<script setup lang="ts">
import { useChannelsStore } from '../../stores/channels';
import { channelNumberSuggestions, channelGroupSuggestions } from '../../channel-identity-suggestions';
import QuickStepActions from './QuickStepActions.vue';
import { computed, ref } from 'vue';
import { ImagePlus, Trash2 } from '@lucide/vue';
import {
	CHANNEL_LOGO_MAX_BYTES,
	CHANNEL_LOGO_MAX_DIMENSION,
	channelCreateSchema,
} from '@moirai/shared';
import { errorMessage } from '../../error-message';
import { prepareChannelLogo, type PreparedChannelLogo } from '../../channel-logo-image';
import type { QuickChannelDraft } from '../../quick-setup';
import TwoStepActionButton from '../TwoStepActionButton.vue';

const draft = defineModel<QuickChannelDraft>({ required: true });
const logo = defineModel<PreparedChannelLogo | null>('logo', { required: true });
const emit = defineEmits<{ back: []; next: [] }>();
const logoInput = ref<HTMLInputElement>();
const preparingLogo = ref(false);
const error = ref('');
const channelsStore = useChannelsStore();
const numberSuggestions = computed(() => channelNumberSuggestions(channelsStore.channels, draft.value.number));
const groupSuggestions = computed(() => channelGroupSuggestions(channelsStore.channels));
const valid = computed(() => !numberSuggestions.value.duplicate && channelCreateSchema.safeParse({
	number: draft.value.number,
	name: draft.value.name,
	group: draft.value.group.trim() || null,
}).success);

/** Replace the optional logo with a full-image bounded PNG preview. */
async function selectLogo(event: Event): Promise<void> {
	const file = (event.target as HTMLInputElement).files?.[0];
	if (!file) {
		return;
	}

	preparingLogo.value = true;
	error.value = '';
	try {
		const video = channelCreateSchema.shape.video.parse(undefined);
		const prepared = await prepareChannelLogo(
			file,
			Math.min(video.width ?? CHANNEL_LOGO_MAX_DIMENSION, CHANNEL_LOGO_MAX_DIMENSION),
			Math.min(video.height ?? CHANNEL_LOGO_MAX_DIMENSION, CHANNEL_LOGO_MAX_DIMENSION),
			CHANNEL_LOGO_MAX_BYTES,
		);
		if (logo.value) {
			URL.revokeObjectURL(logo.value.previewUrl);
		}
		logo.value = prepared;
	}
	catch (cause) {
		error.value = errorMessage(cause);
	}
	finally {
		preparingLogo.value = false;
		if (logoInput.value) {
			logoInput.value.value = '';
		}
	}
}

/** Remove the staged logo and release its local preview URL. */
function removeLogo(): void {
	if (logo.value) {
		URL.revokeObjectURL(logo.value.previewUrl);
	}
	logo.value = null;
}
</script>

<template>
	<section class="quick-step" aria-labelledby="quick-channel-title">
		<div class="quick-step-heading">
			<p class="eyebrow">Step 3 of 4</p>
			<h2 id="quick-channel-title">Name and brand the channel</h2>
			<p>Audio and video settings use the default encoding profile selected under Playback.</p>
		</div>
		<div class="panel form-grid">
			<label><span>Channel number</span><input v-model="draft.number" aria-label="Channel number" :aria-invalid="Boolean(numberSuggestions.duplicate)" aria-describedby="quick-channel-number-feedback" inputmode="decimal" required pattern="[A-Za-z0-9._-]+" />
				<div id="quick-channel-number-feedback" class="channel-number-feedback" aria-live="polite">
					<small v-if="numberSuggestions.duplicate" class="field-error">This number is already used by {{ numberSuggestions.duplicate.name }}.</small>
					<template v-if="numberSuggestions.matches.length">
						<small>Existing channels</small>
						<ul><li v-for="channel in numberSuggestions.matches" :key="channel.id">{{ channel.number }} · {{ channel.name }}</li></ul>
					</template>
				</div>
			</label>
			<label><span>Channel name</span><input v-model="draft.name" required autocapitalize="words" /></label>
			<label class="span-2"><span>Group <small>optional</small></span><input v-model="draft.group" list="quick-channel-group-suggestions" autocapitalize="words" /><datalist id="quick-channel-group-suggestions"><option v-for="group in groupSuggestions" :key="group" :value="group" /></datalist></label>
			<div class="quick-logo-field span-2">
				<span>Channel logo <small>optional</small></span>
				<input ref="logoInput" class="visually-hidden" type="file" accept="image/*" @change="selectLogo" />
				<div v-if="logo" class="quick-logo-preview">
					<img :src="logo.previewUrl" alt="Selected channel logo preview" />
					<TwoStepActionButton class="button secondary" label="Remove logo" confirm-label="Confirm remove logo" confirm-text="Remove" @confirm="removeLogo"><Trash2 :size="16" />Remove</TwoStepActionButton>
				</div>
				<button v-else class="button secondary" type="button" :disabled="preparingLogo" @click="logoInput?.click()">
					<ImagePlus :size="17" />{{ preparingLogo ? 'Preparing…' : 'Choose image' }}
				</button>
				<small>The full image is fitted without cropping and converted to PNG.</small>
			</div>
		</div>
		<p v-if="error" class="notice error">{{ error }}</p>
		<QuickStepActions>
			<button class="button secondary" type="button" :disabled="preparingLogo" @click="emit('back')">Back</button>
			<button class="button" type="button" :disabled="preparingLogo || !valid" @click="emit('next')">Review Setup</button>
		</QuickStepActions>
	</section>
</template>
