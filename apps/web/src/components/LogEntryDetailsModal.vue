<script setup lang="ts">
import { useClipboardFeedback } from '../composables/useClipboardFeedback';
import TransientToast from './TransientToast.vue';
import { computed, onMounted, ref } from 'vue';
import { Copy, X } from '@lucide/vue';
import type { LogEntry } from '@moirai/shared';
import type { LogRequestCompletion } from '../log-entry-context';
import { logRequestDetails } from '../log-entry-context';
import { requestDurationLabel } from '../log-format';
import { useAnimatedDismissal } from '../motion';

const props = defineProps<{
	entry: LogEntry;
	completion: LogRequestCompletion | null;
}>();
const emit = defineEmits<{ close: [] }>();
const { visible, requestClose, finishClose } = useAnimatedDismissal(() => emit('close'));
const dialog = ref<HTMLElement>();
const { message: copyMessage, error: copyError, copy } = useClipboardFeedback();
/** Request metadata extracted from the incoming request context. */
const request = computed(() => logRequestDetails(props.entry.context));
/** Incoming and completion context presented as one request lifecycle. */
const combinedContext = computed(() => {
	if (!props.completion) {
		return props.entry.context;
	}

	return {
		...props.entry.context,
		completion: {
			time: props.completion.entry.time,
			...props.completion.entry.context,
		},
	};
});
/** Complete condensed record written to the clipboard. */
const copyableEntry = computed(() => ({ ...props.entry, context: combinedContext.value }));

/** Format the complete local timestamp shown in log details. */
function formatTimestamp(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'full',
		timeStyle: 'long',
	}).format(new Date(value));
}

/** Format structured values for readable display and clipboard export. */
function formattedJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** Copy structured log data with readable success and persistent failure feedback. */
async function copyValue(value: unknown, kind: 'entry' | 'context'): Promise<void> {
	await copy(formattedJson(value), kind === 'entry' ? 'Complete entry' : 'Context');
}

onMounted(() => dialog.value?.focus());
</script>

<template>
	<Teleport to="body">
		<Transition name="moirai-overlay" appear @after-leave="finishClose">
			<div v-show="visible" class="moirai-dialog-backdrop log-detail-backdrop" :inert="!visible" :aria-hidden="!visible" role="presentation" @mousedown.self="requestClose">
				<section
					ref="dialog"
					v-modal-focus="{ escape: requestClose }"
					class="moirai-dialog log-detail-modal" role="dialog"
					aria-modal="true"
					aria-labelledby="log-detail-title"
					tabindex="-1"
					@keydown.esc="requestClose"
				>
					<div class="modal-heading">
						<div>
							<p class="eyebrow">Server log</p>
							<h2 id="log-detail-title">Log entry details</h2>
						</div>
						<button class="icon-button" type="button" aria-label="Close log details" @click="requestClose">
							<X :size="20" />
						</button>
					</div>

					<div class="log-detail-meta">
						<span class="log-level" :class="`level-${entry.level}`">{{ entry.level }}</span>
						<time :datetime="entry.time">{{ formatTimestamp(entry.time) }}</time>
						<code v-if="entry.requestId">{{ entry.requestId }}</code>
					</div>

					<section class="log-detail-section">
						<h3>Message</h3>
						<p>{{ entry.message || 'Structured log entry' }}</p>
					</section>

					<section
						v-if="request.method || request.endpoint || request.sourceIp || completion"
						class="log-detail-section log-detail-request"
					>
						<h3>Request</h3>
						<dl>
							<div>
								<dt>Method</dt>
								<dd>{{ request.method ?? 'Unavailable' }}</dd>
							</div>
							<div>
								<dt>Endpoint</dt>
								<dd><code>{{ request.endpoint ?? 'Unavailable' }}</code></dd>
							</div>
							<div>
								<dt>Source IP</dt>
								<dd><code>{{ request.sourceIp ?? 'Unavailable' }}</code></dd>
							</div>
							<div v-if="completion">
								<dt>Status</dt>
								<dd>{{ completion.statusCode ?? 'Unavailable' }}</dd>
							</div>
							<div v-if="completion">
								<dt>Duration</dt>
								<dd>{{ requestDurationLabel(completion.durationMs, 'detail') }}</dd>
							</div>
						</dl>
					</section>

					<section class="log-detail-section log-detail-context">
						<div class="log-detail-section-heading">
							<h3>Structured context</h3>
							<button
								v-if="Object.keys(combinedContext).length"
								class="button secondary compact"
								type="button"
								@click="copyValue(combinedContext, 'context')"
							>
								<Copy :size="15" />
								Copy Context
							</button>
						</div>
						<pre v-if="Object.keys(combinedContext).length" tabindex="0">{{ formattedJson(combinedContext) }}</pre>
						<p v-else class="log-detail-empty">This entry has no additional structured context.</p>
					</section>

					<footer class="log-detail-actions">
						<p v-if="copyError" class="notice error" role="alert">{{ copyError }} <button type="button" @click="copyError = ''">Dismiss</button></p>
						<button class="button secondary" type="button" @click="copyValue(copyableEntry, 'entry')">
							<Copy :size="17" />
							Copy Complete Entry
						</button>
					</footer>
					<TransientToast v-if="copyMessage" inline :message="copyMessage" @close="copyMessage = ''" />
				</section>
			</div>
		</Transition>
	</Teleport>
</template>
