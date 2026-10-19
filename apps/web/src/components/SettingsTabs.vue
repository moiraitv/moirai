<script setup lang="ts">
import { useId } from 'vue';

/** A settings area whose draft and failures remain owned by its mounted panel. */
interface SettingsSection {
	id: string;
	label: string;
	dirty?: boolean;
	attention?: boolean;
}

const props = defineProps<{ sections: SettingsSection[] }>();
const selected = defineModel<string>({ required: true });
const prefix = useId();

/** Activate an immediately available panel and retain keyboard focus on its tab. */
function navigate(event: KeyboardEvent, index: number): void {
	let next = index;
	if (event.key === 'ArrowRight') {
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
	const control = event.currentTarget as HTMLButtonElement;
	const tab = control.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
	tab?.focus({ preventScroll: true });
	tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
</script>

<template>
	<div class="settings-tabs">
		<div class="settings-tablist" role="tablist" aria-label="Settings sections">
			<button
				v-for="(section, index) in sections"
				:id="`${prefix}-${section.id}-tab`"
				:key="section.id"
				type="button"
				role="tab"
				:aria-controls="`${prefix}-${section.id}-panel`"
				:aria-selected="selected === section.id"
				:tabindex="selected === section.id ? 0 : -1"
				@click="selected = section.id"
				@keydown="navigate($event, index)"
			>
				{{ section.label }}
				<span v-if="section.dirty" class="settings-tab-dirty"><span aria-hidden="true">●</span><span class="visually-hidden">Unsaved changes</span></span>
				<span v-if="section.attention" class="settings-tab-attention"><span aria-hidden="true">!</span><span class="visually-hidden">Needs attention</span></span>
			</button>
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
