<script setup lang="ts">
import { CalendarClock, ExternalLink, Eye, Layers3, X } from '@lucide/vue';
import AnimatedHelpPanel from '../AnimatedHelpPanel.vue';

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ dismiss: []; learn: [] }>();
</script>

<template>
	<AnimatedHelpPanel :visible="visible" following-space>
		<section id="channel-schedules-about" class="channel-schedules-about dismissible-help-panel" aria-labelledby="channel-schedules-about-title">
			<button type="button" class="dismiss-help-button" aria-label="Dismiss channel schedule help" @click="emit('dismiss')"><X :size="18" /></button>
			<div class="channel-schedules-about-copy">
				<div class="channel-schedules-about-icon"><Layers3 :size="27" /></div>
				<div><h2 id="channel-schedules-about-title">What is a channel schedule?</h2><p>A channel schedule layers reusable templates into one resolved lineup. Start with an always-available base, then add conditional programming for specific days, dates, seasons, or hours.</p><button type="button" class="channel-schedules-learn-link" @click="emit('learn')">Learn More About Channel Schedules <ExternalLink :size="18" /></button></div>
			</div>
			<div class="channel-schedules-benefits">
				<h2>Channel schedules help you</h2>
				<div class="channel-schedules-benefit-grid">
					<article><div class="channel-schedules-benefit-icon tone-green"><Layers3 :size="24" /></div><h3>Keep a reliable base</h3><p>Supply normal programming whenever no higher conditional layer applies.</p></article>
					<article><div class="channel-schedules-benefit-icon tone-blue"><CalendarClock :size="24" /></div><h3>Target special times</h3><p>Combine calendar and time predicates for seasonal or recurring programming.</p></article>
					<article><div class="channel-schedules-benefit-icon tone-purple"><Eye :size="24" /></div><h3>Preview the result</h3><p>Inspect the concrete lineup after template priority and boundaries resolve.</p></article>
				</div>
			</div>
		</section>
	</AnimatedHelpPanel>
</template>
