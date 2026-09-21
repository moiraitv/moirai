<script setup lang="ts">
import { computed, ref } from 'vue';
import { AlertTriangle } from '@lucide/vue';
import type { ScanIssue } from '@moirai/shared';
import { useDisclosureState } from '../../disclosure-state';
import LibraryScanIssuesModal from './LibraryScanIssuesModal.vue';

const props = defineProps<{ count: number; issues: ScanIssue[] }>();
/** Keep the page usable when a scan reports many file-level warnings. */
const INLINE_ISSUE_LIMIT = 10;
const showIssues = useDisclosureState('library-scan-issues', false);
const dialogOpen = ref(false);
const inlineIssues = computed(() => props.issues.slice(0, INLINE_ISSUE_LIMIT));
</script>

<template>
	<div class="reconciliation-banner library-warning-banner" role="alert">
		<span class="reconciliation-icon"><AlertTriangle :size="22" /></span>
		<div>
			<strong>Library scan needs attention</strong>
			<p>{{ count }} scan {{ count === 1 ? 'issue requires' : 'issues require' }} review.</p>
			<Transition name="moirai-collapse">
				<div v-if="showIssues">
					<ul v-if="inlineIssues.length" class="library-warning-issues">
						<li v-for="(issue, index) in inlineIssues" :key="index"><strong>{{ issue.code }}</strong><span>{{ issue.path ?? issue.message }}</span><small v-if="issue.path">{{ issue.message }}</small></li>
					</ul>
					<p v-else>Detailed issues are no longer retained. Run a library sync to refresh the warning state.</p>
					<button v-if="issues.length > INLINE_ISSUE_LIMIT" type="button" class="button secondary library-all-issues" @click="dialogOpen = true">Show all issues ({{ issues.length }})</button>
				</div>
			</Transition>
		</div>
		<button v-if="issues.length" type="button" class="button secondary" :aria-expanded="showIssues" @click="showIssues = !showIssues">{{ showIssues ? 'Hide Issues' : 'Review Issues' }}</button>
	</div>
	<LibraryScanIssuesModal v-if="dialogOpen" :issues="issues" @close="dialogOpen = false" />
</template>
