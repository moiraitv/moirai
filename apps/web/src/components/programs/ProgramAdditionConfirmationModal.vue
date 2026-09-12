<script setup lang="ts">
import { nextTick, onMounted, useTemplateRef } from 'vue';
import { Asterisk, ChevronLeft, ChevronRight, ListPlus } from '@lucide/vue';
import type { ProgramItemAdditionConfirmationItem } from '@moirai/shared/api-contracts';
import { artworkSrcset, artworkVariantUrl } from '../../artwork-url';
import { hideBrokenImage } from '../../image-error';
import MediaCardPreview from '../MediaCardPreview.vue';

/** Exact server-calculated mutation presented before a large program addition. */
interface ProgramAdditionConfirmationProps {
	programName: string;
	alreadySelectedCount: number;
	items: ProgramItemAdditionConfirmationItem[];
	busy: boolean;
}

const props = defineProps<ProgramAdditionConfirmationProps>();
const emit = defineEmits<{
	cancel: [];
	confirm: [];
}>();
const dialog = useTemplateRef<HTMLElement>('dialog');
const carousel = useTemplateRef<HTMLElement>('carousel');

/** Cancel the pending addition while leaving the destination dialog open. */
function cancel(): void {
	if (!props.busy) {
		emit('cancel');
	}
}

/** Move the review carousel by most of one visible viewport. */
function scrollCarousel(direction: -1 | 1): void {
	const track = carousel.value;
	if (!track) {
		return;
	}

	track.scrollBy({
		left: direction * Math.max(150, track.clientWidth * 0.78),
		behavior: 'smooth',
	});
}

onMounted(async () => {
	await nextTick();
	dialog.value?.focus();
});
</script>

<template>
	<Teleport to="body">
		<div class="moirai-dialog-backdrop program-addition-confirmation-backdrop" @click.self="cancel">
			<section
				ref="dialog"
				v-modal-focus="{ escape: cancel }"
				class="moirai-dialog program-addition-confirmation-modal" role="alertdialog"
				aria-modal="true"
				aria-labelledby="program-addition-confirmation-title"
				aria-describedby="program-addition-confirmation-description"
				tabindex="-1"
				@keydown.esc.stop.prevent="cancel"
			>
				<header class="program-addition-confirmation-header">
					<span class="program-addition-confirmation-icon"><ListPlus :size="22" /></span>
					<div>
						<p class="eyebrow">Selected-items program</p>
						<h2 id="program-addition-confirmation-title">Confirm addition</h2>
					</div>
				</header>
				<div id="program-addition-confirmation-description" class="program-addition-confirmation-body">
					<div class="program-addition-carousel-heading">
						<p>Review the items that will be added.</p>
						<div>
							<button type="button" aria-label="Previous items" @click="scrollCarousel(-1)"><ChevronLeft :size="17" /></button>
							<button type="button" aria-label="Next items" @click="scrollCarousel(1)"><ChevronRight :size="17" /></button>
						</div>
					</div>
					<div ref="carousel" class="program-addition-carousel" tabindex="0" aria-label="Items to add">
						<MediaCardPreview v-for="item in items" :key="item.id" :item="item" class="program-addition-preview">
							<article class="program-addition-carousel-card">
								<span>
									<Asterisk :size="28" />
									<img
										v-if="item.artworkUrl"
										:src="artworkVariantUrl(item.artworkUrl, 'card')"
										:srcset="artworkSrcset(item.artworkUrl, 'card')"
										:alt="`${item.title} artwork`"
										loading="lazy"
										decoding="async"
										@error="hideBrokenImage"
									/>
								</span>
								<strong>{{ item.title }}</strong>
								<small v-if="item.year">{{ item.year }}</small>
							</article>
						</MediaCardPreview>
						<p v-if="items.length === 0" class="program-addition-carousel-empty">
							Item previews are no longer available. Submit again to refresh the selection.
						</p>
					</div>
					<p>Add these items to <strong>{{ programName }}</strong>?</p>
					<p v-if="alreadySelectedCount > 0" class="program-addition-confirmation-note">
						{{ alreadySelectedCount.toLocaleString() }}
						{{ alreadySelectedCount === 1 ? 'item is' : 'items are' }} already selected and will be skipped.
					</p>
				</div>
				<footer class="program-addition-confirmation-footer">
					<button type="button" class="button secondary" :disabled="busy" @click="cancel">Cancel</button>
					<button type="button" class="button" :disabled="busy" @click="emit('confirm')">
						{{ busy ? 'Adding…' : 'Add Items' }}
					</button>
				</footer>
			</section>
		</div>
	</Teleport>
</template>
