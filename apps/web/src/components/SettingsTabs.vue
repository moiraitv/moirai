<script setup lang="ts">
import { useId } from 'vue';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

/** A settings area whose draft and failures remain owned by its mounted panel. */
interface SettingsSection {
	id: string;
	label: string;
	to: RouteLocationRaw;
	dirty?: boolean;
	attention?: boolean;
}

const props = defineProps<{ sections: SettingsSection[] }>();
const selected = defineModel<string>({ required: true });
const prefix = useId();

/** Activate an immediately available panel and retain keyboard focus on its tab. */
function navigate(event: KeyboardEvent, index: number): void {
	let next = index;
	if (event.key === ' ') {
		next = index;
	}
	else if (event.key === 'ArrowRight') {
		next = (index + 1) % props.sections.length;
	}
	else if (event.key === 'ArrowLeft') {
		next = (index + props.sections.length - 1) % props.sections.length;
	}
	else if (event.key === 'Home') {
		next = 0;
	}
	else if (event.key === 'End') {
		next = props.sections.length - 1;
	}
	else {
		return;
	}

	event.preventDefault();
	selected.value = props.sections[next]!.id;
	const control = event.currentTarget as HTMLAnchorElement;
	const tab = control.parentElement?.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[next];
	tab?.focus({ preventScroll: true });
	tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
</script>

<template>
	<div class="settings-tabs">
		<div class="settings-tablist" role="tablist" aria-label="Settings sections">
			<RouterLink v-for="(section, index) in sections" :key="section.id" v-slot="{ href, navigate: follow }" :to="section.to" custom>
				<a
					:id="`${prefix}-${section.id}-tab`"
					:href="href"
					role="tab"
					:aria-controls="`${prefix}-${section.id}-panel`"
					:aria-selected="selected === section.id"
					:tabindex="selected === section.id ? 0 : -1"
					@click="follow"
					@keydown="navigate($event, index)"
				>
					{{ section.label }}
					<span v-if="section.dirty" class="settings-tab-dirty"><span aria-hidden="true">●</span><span class="visually-hidden">Unsaved changes</span></span>
					<span v-if="section.attention" class="settings-tab-attention"><span aria-hidden="true">!</span><span class="visually-hidden">Needs attention</span></span>
				</a>
			</RouterLink>
		</div>
		<div
			v-for="section in sections"
			v-show="selected === section.id"
			:id="`${prefix}-${section.id}-panel`"
			:key="section.id"
			class="settings-tabpanel"
			role="tabpanel"
			:aria-labelledby="`${prefix}-${section.id}-tab`"
			tabindex="0"
		>
			<slot :name="section.id" />
		</div>
	</div>
</template>
