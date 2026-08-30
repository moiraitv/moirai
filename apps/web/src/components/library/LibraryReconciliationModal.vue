<script setup lang="ts">
import { X } from '@lucide/vue';
import type { LibraryReconciliation, ReconciliationAction } from '@moirai/shared';
import { missingSinceLabel } from '../../time-format';

defineProps<{ reconciliation: LibraryReconciliation; busy: boolean }>();
const emit = defineEmits<{ close: []; scan: []; reconcile: [action: ReconciliationAction['action']] }>();
</script>

<template>
	<div class="moirai-dialog-backdrop" @click.self="emit('close')">
		<section class="moirai-dialog reconciliation-modal">
			<header class="modal-heading"><div><p class="eyebrow">Library safety</p><h2>Review index reconciliation</h2></div><button type="button" class="icon-button" aria-label="Close reconciliation review" @click="emit('close')"><X :size="20" /></button></header>
			<div v-if="reconciliation.candidateSummary" class="candidate-summary"><div><span>Candidate media</span><strong>{{ reconciliation.candidateSummary.discoveredCount }}</strong></div><div><span>New paths</span><strong>{{ reconciliation.candidateSummary.addedCount }}</strong></div><div><span>Missing paths</span><strong>{{ reconciliation.candidateSummary.missingCount }}</strong></div></div>
			<p v-if="reconciliation.candidateSourceConfig" class="candidate-path">Candidate root <strong>{{ reconciliation.candidateSourceConfig.scanRoot }}</strong></p>
			<p v-if="reconciliation.status === 'observing-removals'">Ordinary removals are applied after {{ reconciliation.requiredObservations }} conclusive observations at least {{ reconciliation.observationIntervalMinutes }} minutes apart.</p>
			<div v-if="reconciliation.missingItems.length" class="reconciliation-items"><article v-for="item in reconciliation.missingItems" :key="item.id"><div class="reconciliation-item-detail"><strong>{{ item.title }}</strong><small>{{ item.relativePath }}</small></div><small class="reconciliation-missing-label">{{ missingSinceLabel(item.firstMissingAt) }}</small></article><small v-if="reconciliation.pendingRemovalCount > reconciliation.missingItems.length">Showing the first {{ reconciliation.missingItems.length }} of {{ reconciliation.pendingRemovalCount }} missing items.</small></div>
			<div class="form-actions reconciliation-actions">
				<button type="button" class="button ghost" :disabled="busy" @click="emit('scan')">Scan again</button>
				<button v-if="reconciliation.sourceChangeCanBeCancelled" type="button" class="button secondary" :disabled="busy" @click="emit('reconcile', 'cancel-source-change')">Cancel source change</button>
				<button v-if="reconciliation.status === 'source-approval-required'" type="button" class="button danger" :disabled="busy" @click="emit('reconcile', 'accept-source')">Accept and replace index</button>
				<button v-if="reconciliation.pendingRemovalCount && reconciliation.status !== 'source-approval-required'" type="button" class="button danger" :disabled="busy" @click="emit('reconcile', 'confirm-removals')">Confirm {{ reconciliation.pendingRemovalCount }} removals</button>
			</div>
		</section>
	</div>
</template>
