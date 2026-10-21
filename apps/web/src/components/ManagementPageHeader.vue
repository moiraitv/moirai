<script setup lang="ts">
import { FileCode, FileText, ListVideo, Settings } from '@lucide/vue';
import { nextTick } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import PageHeader from './PageHeader.vue';

defineProps<{ section: 'Filler' | 'Playback'; title: string; description: string }>();
const route = useRoute();

/** Collection tabs retain existing resource URLs and their editor navigation guards. */
const sections = {
	Filler: [
		{ path: '/filler/pre-rolls', label: 'Pre-Rolls', icon: ListVideo },
		{ path: '/filler/mid-rolls', label: 'Mid-Rolls', icon: ListVideo },
		{ path: '/filler/post-rolls', label: 'Post-Rolls', icon: ListVideo },
		{ path: '/filler/tail-fillers', label: 'Tail Fillers', icon: ListVideo },
	],
	Playback: [
		{ path: '/playback/credit-templates', label: 'Credit Templates', icon: FileText },
		{ path: '/playback/encoding-profiles', label: 'Encoding Profiles', icon: Settings },
		{ path: '/playback/guide-templates', label: 'Guide Templates', icon: FileCode },
	],
};

/** Restore the activated collection link after its owning page is remounted. */
async function activateCollection(event: MouseEvent, navigate: (event?: MouseEvent) => Promise<unknown>, path: string): Promise<void> {
	const restoreFocus = !event.defaultPrevented && event.button === 0
		&& !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
	await navigate(event);
	if (!restoreFocus || route.path !== path) {
		return;
	}

	await nextTick();
	const selected = document.querySelector<HTMLAnchorElement>('.management-tabs a[aria-current="page"]');
	selected?.focus({ preventScroll: true });
	selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
</script>

<template>
	<PageHeader :title="section" :description="description" :help-label="title"><slot /></PageHeader>
	<nav class="management-tabs" :aria-label="`${section} sections`">
		<RouterLink
			v-for="tab in sections[section]" :key="tab.path" v-slot="{ href, navigate }"
			:to="tab.path" custom
		>
			<a
				:href="href"
				:class="{ 'router-link-active': route.path === tab.path || route.path.startsWith(`${tab.path}/`) }"
				:aria-current="route.path === tab.path || route.path.startsWith(`${tab.path}/`) ? 'page' : undefined"
				@click="activateCollection($event, navigate, tab.path)"
			>
				<component :is="tab.icon" :size="18" aria-hidden="true" />{{ tab.label }}
			</a>
		</RouterLink>
	</nav>
</template>
