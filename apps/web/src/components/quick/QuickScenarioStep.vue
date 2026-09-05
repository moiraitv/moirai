<script setup lang="ts">
import { Film, Music2, TvMinimal } from '@lucide/vue';
import type { QuickChannelScenario } from '@moirai/shared';
import { QUICK_SCENARIOS } from '../../quick-setup';

const emit = defineEmits<{ choose: [scenario: QuickChannelScenario, event: MouseEvent] }>();
const icons = { movies: Film, shows: TvMinimal, 'music-videos': Music2 };
</script>

<template>
	<section class="quick-start" aria-labelledby="quick-scenario-title">
		<div class="quick-step-heading">
			<h2 id="quick-scenario-title">What would you like to make?</h2>
			<p>Quickly create a basic channel using your media library for what you'd like to see.</p>
		</div>
		<div class="quick-scenario-grid">
			<button
				v-for="preset in QUICK_SCENARIOS"
				:key="preset.id"
				type="button"
				class="quick-scenario-card"
				@click="emit('choose', preset.id, $event)"
			>
				<span class="quick-scenario-icon"><component :is="icons[preset.id]" :size="28" /></span>
				<strong>{{ preset.title }}</strong>
				<small>{{ preset.description }}</small>
			</button>
		</div>
	</section>
</template>
