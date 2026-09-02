<script setup lang="ts">
import { X } from '@lucide/vue';
import type { LibraryReconciliation, ReconciliationAction } from '@moirai/shared';
import { missingSinceLabel } from '../../time-format';
import { useAnimatedDismissal } from '../../motion';
import { countLabel } from '../../count-label';

defineProps<{ reconciliation: LibraryReconciliation; busy: boolean }>();
const emit = defineEmits<{ close: []; scan: []; reconcile: [action: ReconciliationAction['action']] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
</script>

<template>
	<Transition name="moirai-overlay" appear @after-leave="finishClose">
		<div v-show="visible" class="moirai-dialog-backdrop" :inert="!visible" :aria-hidden="!visible" @click.self="requestClose">
			<section class="moirai-dialog reconciliation-modal">
				<header class="modal-heading"><div><p class="eyebrow">Library safety</p><h2>Review index reconciliation</h2></div><button type="button" class="icon-button" aria-label="Close reconciliation review" @click="requestClose"><X :size="20" /></button></header>
				<div v-if="reconciliation.candidateSummary" class="candidate-summary"><div><span>Candidate media</span><strong>{{ reconciliation.candidateSummary.discoveredCount }}</strong></div><div><span>New paths</span><strong>{{ reconciliation.candidateSummary.addedCount }}</strong></div><div><span>Missing paths</span><strong>{{ reconciliation.candidateSummary.missingCount }}</strong></div></div>
				<p v-if="reconciliation.candidateSourceConfig" class="candidate-path">Candidate root <strong>{{ reconciliation.candidateSourceConfig.scanRoot }}</strong></p>
				<p v-if="reconciliation.status === 'observing-removals'">Ordinary removals are applied after {{ countLabel(reconciliation.requiredObservations, 'conclusive observation') }} at least {{ countLabel(reconciliation.observationIntervalMinutes, 'minute') }} apart.</p>
				<div v-if="reconciliation.missingItems.length" class="reconciliation-items"><article v-for="item in reconciliation.missingItems" :key="item.id"><div class="reconciliation-item-detail"><strong>{{ item.title }}</strong><small>{{ item.relativePath }}</small></div><small class="reconciliation-missing-label">{{ missingSinceLabel(item.firstMissingAt) }}</small></article><small v-if="reconciliation.pendingRemovalCount > reconciliation.missingItems.length">Showing the first {{ reconciliation.missingItems.length }} of {{ reconciliation.pendingRemovalCount }} missing items.</small></div>
				<div class="form-actions reconciliation-actions">
					<button type="button" class="button ghost" :disabled="busy" @click="emit('scan')">Scan Again</button>
					<button v-if="reconciliation.sourceChangeCanBeCancelled" type="button" class="button secondary" :disabled="busy" @click="emit('reconcile', 'cancel-source-change')">Cancel Source Change</button>
					<button v-if="reconciliation.status === 'source-approval-required'" type="button" class="button danger" :disabled="busy" @click="emit('reconcile', 'accept-source')">Accept and Replace Index</button>
					<button v-if="reconciliation.pendingRemovalCount && reconciliation.status !== 'source-approval-required'" type="button" class="button danger" :disabled="busy" @click="emit('reconcile', 'confirm-removals')">Confirm {{ countLabel(reconciliation.pendingRemovalCount, 'Removal') }}</button>
				</div>
			</section>
		</div>
	</Transition>
</template>
