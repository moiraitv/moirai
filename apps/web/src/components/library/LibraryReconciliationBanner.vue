<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
import type { LibraryReconciliation } from '@moirai/shared';
import { countLabel } from '../../count-label';

defineProps<{ reconciliation: LibraryReconciliation }>();
const emit = defineEmits<{ review: [] }>();
</script>

<template>
	<div
		v-if="reconciliation.status !== 'idle'"
		class="reconciliation-banner"
	>
		<span class="reconciliation-icon"><AlertTriangle :size="22" /></span>
		<div>
			<strong v-if="reconciliation.status === 'source-approval-required'">Library source change needs review</strong>
			<strong v-else-if="reconciliation.status === 'source-accepting'">Updating library source</strong>
			<strong v-else-if="reconciliation.status === 'observing-removals'">Checking missing library media</strong>
			<strong v-else>Library index needs review</strong>
			<p v-if="reconciliation.status === 'source-approval-required'">The media source changed. Review and approve the new source before Moirai updates the library index.</p>
			<p v-else-if="reconciliation.status === 'source-accepting'">The source change was approved. Moirai must finish scanning the new source before updating the library index.</p>
			<p v-else-if="reconciliation.status === 'observing-removals' && reconciliation.pendingRemovalCount > 0">{{ countLabel(reconciliation.pendingRemovalCount, 'indexed item') }} {{ reconciliation.pendingRemovalCount === 1 ? 'was' : 'were' }} not found. Moirai is checking the source before confirming removal.</p>
			<p v-else-if="reconciliation.pendingRemovalCount > 0">{{ countLabel(reconciliation.pendingRemovalCount, 'indexed item') }} {{ reconciliation.pendingRemovalCount === 1 ? 'was' : 'were' }} not found. Review the missing media before confirming removal.</p>
			<p v-else>Review the library source and scan results before updating the index.</p>
		</div>
		<button class="button secondary" @click="emit('review')">Review</button>
	</div>
</template>
