<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, BookOpen, X } from '@lucide/vue';
import LoadingState from './LoadingState.vue';

/** One restricted contextual topic generated from the bundled guide. */
interface HelpTopic {
	id: string;
	title: string;
	description: string;
	html: string;
	fullPath: string;
	reviewStatus: 'needs-review' | 'reviewed';
}

/** Versioned contextual-help manifest bundled with this application build. */
interface HelpManifest {
	version: 1;
	guideVersion: string;
	topics: Record<string, HelpTopic>;
}

const props = defineProps<{ topicId: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement>();
const manifest = ref<HelpManifest>();
const loading = ref(true);
const error = ref('');
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
const topic = computed(() => manifest.value?.topics[props.topicId]);

/** Load the version-matched topic manifest bundled with the application. */
async function loadTopic(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		const response = await fetch('/help/contextual-help.json', { cache: 'no-cache' });
		if (!response.ok) {
			throw new Error(`Help returned ${response.status}`);
		}
		manifest.value = await response.json() as HelpManifest;
		if (!manifest.value.topics[props.topicId]) {
			throw new Error('This part of Moirai does not have contextual guidance yet.');
		}
	}
	catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'Contextual help could not be loaded.';
	}
	finally {
		loading.value = false;
		await nextTick();
		dialog.value?.focus();
	}
}

/** Keep keyboard focus inside the modal help drawer and dismiss it with Escape. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		event.preventDefault();
		emit('close');
		return;
	}
	if (event.key !== 'Tab') {
		return;
	}

	const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>(
		'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])',
	) ?? [])];
	const first = focusable[0] ?? dialog.value;
	const last = focusable.at(-1) ?? dialog.value;
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last?.focus();
	}
	else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first?.focus();
	}
}

watch(() => props.topicId, () => void loadTopic());
onMounted(() => void loadTopic());
onUnmounted(() => opener?.focus());
</script>

<template>
	<Teleport to="body">
		<div class="help-drawer-backdrop" @mousedown.self="emit('close')">
			<aside
				ref="dialog"
				class="help-drawer"
				role="dialog"
				aria-modal="true"
				aria-label="Moirai help"
				:aria-labelledby="topic ? 'help-drawer-title' : undefined"
				tabindex="-1"
				@keydown="handleKeydown"
			>
				<header>
					<div class="help-drawer-heading">
						<BookOpen :size="20" />
						<span>Help · Moirai {{ manifest?.guideVersion }}</span>
					</div>
					<button class="icon-button" type="button" aria-label="Close help" @click="emit('close')">
						<X :size="20" />
					</button>
				</header>

				<div class="help-drawer-content">
					<LoadingState v-if="loading" label="Loading help…" />
					<div v-else-if="error" class="notice error" role="alert">
						<strong>Help is unavailable</strong>
						<span>{{ error }}</span>
					</div>
					<template v-else-if="topic">
						<div v-if="topic.reviewStatus === 'needs-review'" class="help-review-warning" role="status">
							<strong>Needs review</strong>
							This first-pass guidance has not been approved for production.
						</div>
						<p class="eyebrow">Contextual guide</p>
						<h2 id="help-drawer-title">{{ topic.title }}</h2>
						<p class="help-drawer-description">{{ topic.description }}</p>
						<!-- eslint-disable-next-line vue/no-v-html -->
						<div class="help-markdown" v-html="topic.html"></div>
					</template>
				</div>

				<footer v-if="topic">
					<a class="button primary" :href="topic.fullPath" target="_blank" rel="noopener">
						Open full guide <ArrowUpRight :size="17" />
					</a>
				</footer>
			</aside>
		</div>
	</Teleport>
</template>
