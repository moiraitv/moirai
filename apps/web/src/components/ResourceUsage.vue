<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, nextTick, useId, useTemplateRef } from 'vue';
import { ChevronLeft, ChevronRight, GitBranch, Info, CalendarDays, FileText, ListVideo, Tv, X } from '@lucide/vue';
import type { ResourceUsage, ResourceUsageKind } from '@moirai/shared';
import { api } from '../api';
import { errorMessage } from '../error-message';
import MediaPlayingAt from './MediaPlayingAt.vue';
import LoadingState from './LoadingState.vue';

const props = defineProps<{ kind: ResourceUsageKind; resourceId: string | undefined; revision?: number; inline?: boolean }>();
const open = ref(Boolean(props.inline));
const page = ref(1);
const result = ref<ResourceUsage | null>(null);
const loading = ref(false);
const error = ref('');
const layout = useTemplateRef<HTMLElement>('layout');
const sidebar = ref<HTMLElement>();
const headerToggle = ref<HTMLButtonElement>();
const contentId = useId();
let animations: Animation[] = [];
let sequence = 0;
const headered = computed(() => props.kind !== 'media');
const usageIcon = computed(() => props.kind === 'media' ? Tv : GitBranch);
const headerSlot = computed(() => {
	if (!headered.value || props.inline) {
		return null;
	}

	const slot = layout.value?.closest('[role="dialog"]')?.querySelector('.resource-editor-usage-slot');
	return slot instanceof HTMLElement ? slot : null;
});
const headerToggleName = computed(() => (
	result.value ? `Used by ${result.value.total}` : 'Used by'
));

/** Resize the content through the contained CSS transition without scaling text or controls. */
async function toggleOpen(): Promise<void> {
	for (const animation of animations) {
		animation.cancel();
	}
	const closing = open.value;
	open.value = !open.value;
	await nextTick();
	if (closing && headered.value) {
		headerToggle.value?.focus({ preventScroll: true });
	}
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !sidebar.value) {
		return;
	}
	animations = [sidebar.value.animate([{ opacity: .4 }, { opacity: 1 }], {
		duration: 350, easing: 'ease-in-out',
	})];
}
/** Describe the concrete referencing resource without implying transitive channel usage. */
function ownerLabel(kind: ResourceUsage['items'][number]['kind']): string {
	return { program: 'Program', template: 'Template', 'channel-schedule': 'Channel schedule', channel: 'Channel' }[kind];
}
/** Match reference cards to the existing resource icons used throughout navigation. */
function ownerIcon(kind: ResourceUsage['items'][number]['kind']) {
	return { program: ListVideo, template: FileText, 'channel-schedule': CalendarDays, channel: Tv }[kind];
}
/** Read only the current disclosure page and ignore responses belonging to a closed editor. */
async function load(): Promise<void> {
	if (!props.resourceId) {
		return;
	}
	const request = ++sequence;
	loading.value = true;
	error.value = '';
	try {
		const value = await api.resourceUsage(props.kind, props.resourceId, page.value);
		if (request === sequence) {
			result.value = value;
		}
	}
	catch (cause) {
		if (request === sequence) {
			error.value = errorMessage(cause);
		}
	}
	finally {
		if (request === sequence) {
			loading.value = false;
		}
	}
}
/** Open the direct owner's editor through ordinary guarded application navigation. */
function destination(item: ResourceUsage['items'][number]): string {
	if (item.kind === 'channel') {
		return `/channels?edit=${item.id}`;
	}
	return `/schedules/${item.kind === 'channel-schedule' ? 'channels' : item.kind + 's'}/${item.id}`;
}
watch(() => `${props.kind}:${props.resourceId ?? ''}:${props.revision ?? ''}`, () => {
	sequence++;
	result.value = null;
	page.value = 1;
	if (props.resourceId && (open.value || props.kind !== 'media')) {
		void load();
	}
}, { immediate: true });
watch(open, (isOpen) => {
	if (isOpen && props.resourceId && !result.value) {
		void load();
	}
});
watch(() => props.resourceId, () => {
	open.value = Boolean(props.inline);
});
onBeforeUnmount(() => {
	for (const animation of animations) {
		animation.cancel();
	}
	sequence++;
});
</script>

<template>
	<div ref="layout" class="resource-usage-layout" :class="{ 'has-usage': resourceId, 'usage-open': open && resourceId, 'usage-header': headered && !inline, 'usage-inline': inline }">
		<div class="resource-usage-main"><slot /></div>
		<Teleport v-if="headerSlot && resourceId" :to="headerSlot">
			<button ref="headerToggle" class="resource-usage-header-toggle" type="button" :title="open ? 'Collapse Used by' : 'Expand Used by'" :aria-expanded="open" :aria-controls="contentId" @click="toggleOpen">
				<GitBranch :size="18" aria-hidden="true" /><strong>{{ headerToggleName }}</strong><ChevronRight v-if="!open" :size="16" aria-hidden="true" />
			</button>
		</Teleport>
		<aside v-if="resourceId && (!headered || open)" ref="sidebar" class="resource-usage" aria-label="Resource usage">
			<button v-if="!headered" class="resource-usage-toggle" type="button" aria-label="Used by" :title="open ? 'Collapse Used by' : 'Expand Used by'" :aria-expanded="open" :aria-controls="contentId" @click="toggleOpen">
				<component :is="usageIcon" :size="20" aria-hidden="true" /><strong v-if="open">Used by</strong><component :is="open ? ChevronRight : ChevronLeft" :size="16" aria-hidden="true" />
			</button>
			<div v-show="open" :id="contentId" class="resource-usage-content">
				<div v-if="headered" class="resource-usage-panel-header">
					<GitBranch :size="18" aria-hidden="true" /><strong :class="{ eyebrow: inline }">Used by</strong>
					<button v-if="!inline" class="icon-button" type="button" aria-label="Collapse Used by" @click="toggleOpen">
						<X :size="18" aria-hidden="true" />
					</button>
				</div>
				<LoadingState v-if="loading" label="Loading references…" />
				<div v-else-if="error"><p class="notice error" role="alert">{{ error }}</p><button class="button secondary" type="button" @click="load">Retry</button></div>
				<template v-else-if="result">
					<p v-if="!result.total">{{ kind === 'media' ? 'No programs currently select this item.' : 'No direct references.' }}</p>
					<template v-else>
						<p>This {{ kind === 'media' ? 'media item' : kind.replace('-', ' ') }} is currently used by {{ result.total }} {{ result.total === 1 ? 'resource' : 'resources' }}.</p>
						<ul>
							<li v-for="item in result.items" :key="`${item.kind}:${item.id}`">
								<RouterLink :to="destination(item)" :aria-label="item.name" class="resource-usage-card">
									<component :is="ownerIcon(item.kind)" :size="20" aria-hidden="true" />
									<span><strong>{{ item.name }}</strong><small>{{ ownerLabel(item.kind) }}</small><small>{{ item.roles.join(' · ') }} · {{ item.referenceCount }} {{ item.referenceCount === 1 ? 'reference' : 'references' }}</small></span>
									<ChevronRight :size="16" aria-hidden="true" />
								</RouterLink>
							</li>
						</ul>
						<div v-if="result.total > 50" class="form-actions"><button type="button" class="button secondary" :disabled="page === 1" @click="page--; load()">Previous</button><span>Page {{ page }} of {{ Math.ceil(result.total / 50) }}</span><button type="button" class="button secondary" :disabled="page * 50 >= result.total" @click="page++; load()">Next</button></div>
					</template>
					<p class="resource-usage-note"><Info :size="18" aria-hidden="true" /><span v-if="kind === 'media'">Includes selected items, groups, and matching library queries, including query limits.</span><span v-else>Changes affect these direct references. Other channels may be affected indirectly.</span></p>
				</template>
				<MediaPlayingAt v-if="open && kind === 'media' && resourceId" :resource-id="resourceId" />
			</div>
		</aside>
	</div>
</template>
