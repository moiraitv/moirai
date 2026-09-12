<script setup lang="ts">
import { useDraftProtection } from '../draft-protection';
import PageHelpButton from '../components/PageHelpButton.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { storeToRefs } from 'pinia';
import { CheckCircle2, RotateCcw, WandSparkles } from '@lucide/vue';
import {
	DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES,
	type Library,
	type LibraryCreate,
	type QuickChannelScenario,
	type QuickChannelSetupCreate,
} from '@moirai/shared';
import type { QuickChannelSetupResult } from '@moirai/shared/api-contracts';
import { api } from '../api';
import type { PreparedChannelLogo } from '../channel-logo-image';
import QuickChannelStep from '../components/quick/QuickChannelStep.vue';
import QuickLibraryStep from '../components/quick/QuickLibraryStep.vue';
import QuickProgrammingStep from '../components/quick/QuickProgrammingStep.vue';
import QuickReviewStep from '../components/quick/QuickReviewStep.vue';
import QuickScenarioStep from '../components/quick/QuickScenarioStep.vue';
import { animateQuickSuccess } from '../components/quick/quick-success-motion';
import LoadingState from '../components/LoadingState.vue';
import PageHeader from '../components/PageHeader.vue';
import ResourceEditorHeader from '../components/ResourceEditorHeader.vue';
import { requestConfirmation } from '../confirmation';
import { errorMessage } from '../error-message';
import { emptyCatalogProgramItemFilter } from '../components/library/library-filter';
import { liveEvents } from '../live-events';
import {
	compatibleQuickLibraries,
	quickScenarioPreset,
	quickSelectionStrategy,
	suggestedQuickTemplateName,
	suggestedQuickChannelNumber,
	type QuickChannelDraft,
	type QuickProgrammingDraft,
} from '../quick-setup';
import { useChannelsStore } from '../stores/channels';
import { useLibrariesStore } from '../stores/libraries';
import { useSchedulingStore } from '../stores/scheduling';

const librariesStore = useLibrariesStore();
const channelsStore = useChannelsStore();
const schedulingStore = useSchedulingStore();
const { libraries } = storeToRefs(librariesStore);
const { channels } = storeToRefs(channelsStore);
const loading = ref(true);
const modalOpen = ref(false);
const compactSuccess = ref(false);
const launchButton = ref<HTMLButtonElement>();
const modal = ref<HTMLElement>();
const initialError = ref('');
const stage = ref(0);
const scenario = ref<QuickChannelScenario | null>(null);
const configuredScenario = ref<QuickChannelScenario | null>(null);
const libraryMode = ref<'existing' | 'new'>('existing');
const libraryId = ref('');
const createdLibraryId = ref<string | null>(null);
const createdLibrary = ref<Library | null>(null);
const libraryBusy = ref(false);
const libraryError = ref('');
const setupBusy = ref(false);
const setupError = ref('');
const logo = ref<PreparedChannelLogo | null>(null);
const logoError = ref('');
const result = ref<QuickChannelSetupResult | null>(null);
const scanRevision = ref(0);
let newLibrary = reactive<LibraryCreate>({
	name: '',
	typeKey: 'movies',
	sourceType: 'on-disk',
	sourceConfig: { scanRoot: '', playbackRoot: null },
	scanIntervalMinutes: DEFAULT_FALLBACK_SCAN_INTERVAL_MINUTES,
	watcherEnabled: true,
	enabled: true,
});
let programming = reactive<QuickProgrammingDraft>({
	name: '',
	sourceType: 'library-query',
	filter: emptyCatalogProgramItemFilter(),
	querySort: { type: 'name', direction: 'asc' },
	queryItemLimit: null,
	items: [],
	groups: [],
	strategy: 'shuffle',
	seed: '',
});
let channel = reactive<QuickChannelDraft>({ number: '', name: '', group: '' });
const compatibleLibraries = computed(() => {
	if (!scenario.value) {
		return [];
	}

	const compatible = compatibleQuickLibraries(libraries.value, scenario.value);
	const localLibrary = createdLibrary.value;
	if (
		localLibrary?.typeKey === scenario.value
		&& !compatible.some((library) => library.id === localLibrary.id)
	) {
		return [...compatible, localLibrary];
	}
	return compatible;
});
const selectedLibrary = computed(() => compatibleLibraries.value
	.find((library) => library.id === libraryId.value));
const selectedLibraryScanning = computed(() => Boolean(
	selectedLibrary.value?.lastScanStartedAt
	&& (
		!selectedLibrary.value.lastScanCompletedAt
		|| selectedLibrary.value.lastScanStartedAt > selectedLibrary.value.lastScanCompletedAt
	),
));
const templateName = computed(() => suggestedQuickTemplateName(
	channel.name,
	schedulingStore.overview?.templates.map((template) => template.name) ?? [],
));
const dirty = computed(() => configuredScenario.value !== null && result.value === null);
const request = computed<QuickChannelSetupCreate | null>(() => {
	if (!scenario.value || !selectedLibrary.value) {
		return null;
	}
	const source: QuickChannelSetupCreate['source'] = programming.sourceType === 'library-query'
		? {
			type: 'library-query',
			...programming.filter,
			sort: programming.querySort,
			itemLimit: programming.queryItemLimit,
		}
		: programming.sourceType === 'group-collection'
			? { type: 'group-collection', groupIds: programming.groups.map((group) => group.id) }
			: { type: 'collection', itemIds: programming.items.map((item) => item.id) };
	return {
		scenario: scenario.value,
		libraryId: selectedLibrary.value.id,
		programName: programming.name,
		source,
		strategy: quickSelectionStrategy(programming.strategy, programming.seed),
		channel: {
			number: channel.number,
			name: channel.name,
			group: channel.group.trim() || null,
		},
	};
});

/** Open a preset at the library step and remember its card for focus restoration. */
function configureScenario(selected: QuickChannelScenario, event: MouseEvent): void {
	scenario.value = selected;
	launchButton.value = event.currentTarget as HTMLButtonElement;
	if (!scenario.value) {
		return;
	}
	if (configuredScenario.value !== scenario.value) {
		const preset = quickScenarioPreset(scenario.value);
		configuredScenario.value = scenario.value;
		newLibrary.name = preset.libraryName;
		newLibrary.typeKey = scenario.value;
		newLibrary.sourceConfig.scanRoot = '';
		newLibrary.sourceConfig.playbackRoot = null;
		programming.name = preset.programName;
		programming.sourceType = 'library-query';
		programming.filter = emptyCatalogProgramItemFilter();
		programming.querySort = { type: 'name', direction: 'asc' };
		programming.queryItemLimit = null;
		programming.items = [];
		programming.groups = [];
		programming.strategy = preset.strategy;
		programming.seed = '';
		channel.number = suggestedQuickChannelNumber(channels.value.map((entry) => entry.number));
		channel.name = preset.channelName;
		channel.group = preset.group;
		libraryId.value = compatibleLibraries.value[0]?.id ?? '';
		libraryMode.value = compatibleLibraries.value.length > 0 ? 'existing' : 'new';
	}
	stage.value = 1;
	modalOpen.value = true;
}

/** Persist a new library, keep it selected, and continue while its scan runs. */
async function createLibrary(): Promise<void> {
	libraryBusy.value = true;
	libraryError.value = '';
	try {
		const created = await api.createLibrary({
			...newLibrary,
			sourceConfig: { ...newLibrary.sourceConfig, playbackRoot: null },
		});
		createdLibraryId.value = created.id;
		createdLibrary.value = created;
		libraryId.value = created.id;
		libraryMode.value = 'existing';
		await librariesStore.load().catch(() => undefined);
		stage.value = 2;
	}
	catch (cause) {
		libraryError.value = errorMessage(cause);
	}
	finally {
		libraryBusy.value = false;
	}
}

/** Upload committed setup branding without applying late retries to a subsequent draft. */
async function uploadLogo(): Promise<void> {
	if (!result.value || !logo.value) {
		return;
	}
	const target = result.value;
	logoError.value = '';
	try {
		const channelWithLogo = await api.uploadChannelLogo(
			target.channel.id,
			logo.value.blob,
		);
		if (result.value === target) {
			result.value = { ...target, channel: channelWithLogo };
		}
	}
	catch (cause) {
		if (result.value === target) {
			logoError.value = errorMessage(cause);
		}
	}
}

/** Atomically create the core resources and then attempt optional branding upload. */
async function finish(): Promise<void> {
	if (!request.value || setupBusy.value) {
		return;
	}
	setupBusy.value = true;
	setupError.value = '';
	try {
		result.value = await api.createQuickChannelSetup(request.value);
		stage.value = 5;
		await uploadLogo();
		await Promise.allSettled([
			channelsStore.loadChannels(),
			schedulingStore.load(),
		]);
	}
	catch (cause) {
		setupError.value = errorMessage(cause);
	}
	finally {
		setupBusy.value = false;
	}
}

/** Release the current draft and return to scenario selection. */
function startAnother(): void {
	compactSuccess.value = false;
	if (logo.value) {
		URL.revokeObjectURL(logo.value.previewUrl);
	}
	logo.value = null;
	logoError.value = '';
	libraryError.value = '';
	setupError.value = '';
	result.value = null;
	configuredScenario.value = null;
	scenario.value = null;
	createdLibraryId.value = null;
	createdLibrary.value = null;
	stage.value = 0;
}

/** Keep focus in the persistent dialog while the outgoing step and its footer are removed. */
function stepLeaving(): void {
	if (modal.value?.contains(document.activeElement)) {
		modal.value.focus({ preventScroll: true });
	}
}

/** Focus each new step heading and fit the completed setup before morphing its dialog surface. */
async function stepEntered(step: Element): Promise<void> {
	if (!modal.value) {
		return;
	}
	const heading = step.querySelector<HTMLElement>('h2');
	if (heading) {
		heading.tabIndex = -1;
		heading.focus();
	}
	if (stage.value !== 5) {
		return;
	}
	const element = modal.value;
	const previous = element.getBoundingClientRect();
	compactSuccess.value = true;
	await nextTick();
	if (modal.value !== element) {
		return;
	}
	animateQuickSuccess(element, previous);
}

/** Ask before abandoning a configured or partially persisted wizard. */
async function confirmLeave(): Promise<boolean> {
	if (libraryBusy.value || setupBusy.value) {
		return false;
	}
	if (!dirty.value) {
		return true;
	}
	return await requestConfirmation({
		key: 'leave-quick-setup',
		title: 'Leave Quick Setup?',
		message: createdLibraryId.value
			? 'Discard this setup draft? The library already created by this wizard will remain and continue scanning.'
			: 'Discard this Quick Setup draft?',
		confirmLabel: 'Discard Draft',
		destructive: true,
	});
}

/** Dismiss every modal exit through the same draft confirmation and restore launch focus. */
async function closeSetup(): Promise<void> {
	if (await confirmLeave()) {
		startAnother();
		modalOpen.value = false;
		await nextTick();
		launchButton.value?.focus();
	}
}

/** Keep keyboard navigation inside the setup while respecting nested dialog handlers. */
function handleEscape(event: KeyboardEvent): void {
	if (event.defaultPrevented || !modalOpen.value) {
		return;
	}
	if (event.key === 'Escape' && !event.defaultPrevented && modalOpen.value) {
		event.preventDefault();
		void closeSetup();
	}
}


/** Load every shared collection required to initialize a wizard safely. */
async function loadInitial(): Promise<void> {
	loading.value = true;
	initialError.value = '';
	try {
		await Promise.all([
			librariesStore.load(),
			channelsStore.loadChannels(),
			channelsStore.capabilitiesLoaded ? Promise.resolve() : channelsStore.loadCapabilities(),
			schedulingStore.load(),
		]);
		if (librariesStore.error) {
			initialError.value = librariesStore.error;
		}
	}
	catch (cause) {
		initialError.value = errorMessage(cause);
	}
	finally {
		loading.value = false;
	}
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (event.type === 'library.changed' || event.type === 'scan.changed') {
		librariesStore.scheduleRefresh();
		if (event.data.libraryId === libraryId.value && event.data.affectsProgramming) {
			scanRevision.value += 1;
		}
	}
});
onBeforeRouteLeave(async () => await confirmLeave());
watch(libraryId, () => {
	programming.items = [];
	programming.groups = [];
});
watch(modal, (element) => element?.querySelector<HTMLButtonElement>('.resource-editor-close')?.focus());
watch(compatibleLibraries, (available) => {
	if (libraryMode.value === 'existing' && !available.some((library) => library.id === libraryId.value)) {
		libraryId.value = available[0]?.id ?? '';
		if (available.length === 0) {
			libraryMode.value = 'new';
		}
	}
});
onMounted(async () => {
	await loadInitial();
});
onBeforeUnmount(() => {
	unsubscribe();
	if (logo.value) {
		URL.revokeObjectURL(logo.value.previewUrl);
	}
});
useDraftProtection(() => modalOpen.value && dirty.value);
</script>

<template>
	<section>
		<div>
			<PageHeader eyebrow="Fast start" title="Quick Setup" description="Turn a media folder into a working IPTV channel in a few simple steps." />
			<LoadingState v-if="loading" label="Loading setup options…" />
			<div v-else-if="initialError" class="empty-state panel">
				<h2>Quick Setup could not load</h2>
				<p>{{ initialError }}</p>
				<button class="button" type="button" @click="loadInitial">Retry</button>
			</div>
			<QuickScenarioStep v-else @choose="configureScenario" />
		</div>
		<div v-if="modalOpen" class="moirai-dialog-backdrop" @click.self="closeSetup" @keydown="handleEscape">
			<section ref="modal" v-modal-focus="{ escape: closeSetup }" class="moirai-dialog quick-setup-modal" :class="{ 'quick-setup-complete': compactSuccess }" role="dialog" aria-modal="true" aria-labelledby="quick-setup-title" tabindex="-1">
				<ResourceEditorHeader close-label="Close Quick Setup" :disabled="libraryBusy || setupBusy" @close="closeSetup">
					<p class="eyebrow">Fast start</p>
					<div class="resource-editor-title-with-help"><h2 id="quick-setup-title">Quick Setup</h2><PageHelpButton label="Quick Setup" topic-id="getting-started.first-channel" /></div>
				</ResourceEditorHeader>
				<div class="quick-setup-scroll">
					<div class="quick-setup-shell">
						<ol v-if="stage > 0 && stage < 5" class="quick-progress" aria-label="Setup progress">
							<li v-for="(label, index) in ['Library', 'Programming', 'Channel', 'Review']" :key="label" :class="{ active: stage === index + 1, complete: stage > index + 1 }">
								<span>{{ index + 1 }}</span>{{ label }}
							</li>
						</ol>
						<Transition name="quick-step" mode="out-in" @before-leave="stepLeaving" @enter="stepEntered">
							<QuickLibraryStep
								v-if="stage === 1 && scenario"
								v-model:mode="libraryMode"
								v-model:library-id="libraryId"
								v-model:new-library="newLibrary"
								:scenario="scenario"
								:libraries="compatibleLibraries"
								:busy="libraryBusy"
								:error="libraryError"
								@back="closeSetup"
								@next="stage = 2"
								@create="createLibrary"
							/>
							<QuickProgrammingStep
								v-else-if="stage === 2 && scenario && selectedLibrary"
								v-model="programming"
								:scenario="scenario"
								:library-id="selectedLibrary.id"
								:library-name="selectedLibrary.name"
								:library-scanning="selectedLibraryScanning"
								:item-limit="channelsStore.maxExplicitMediaItems"
								:refresh-revision="scanRevision"
								@back="stage = 1"
								@next="stage = 3"
							/>
							<QuickChannelStep v-else-if="stage === 3" v-model="channel" v-model:logo="logo" @back="stage = 2" @next="stage = 4" />
							<QuickReviewStep v-else-if="stage === 4 && request && selectedLibrary" :request="request" :library="selectedLibrary" :logo="logo" :busy="setupBusy" :error="setupError" :template-name="templateName" @back="stage = 3" @finish="finish" />
							<section v-else-if="stage === 5 && result" class="quick-step quick-success" aria-labelledby="quick-success-title">
								<CheckCircle2 :size="48" />
								<p class="eyebrow">Channel ready</p>
								<h2 id="quick-success-title">{{ result.channel.number }} · {{ result.channel.name }}</h2>
								<p>The program, continuous daily template, channel, and schedule are ready to use.</p>
								<p v-if="setupBusy && logo && !logoError" role="status">Finishing channel branding…</p>
								<p v-if="logoError" class="notice warning">The channel is ready, but its logo could not be uploaded: {{ logoError }} <button class="button secondary" type="button" @click="uploadLogo">Retry Logo Upload</button></p>
								<div class="quick-success-actions">
									<RouterLink class="button" :to="`/schedules/channels/${result.channel.id}`">Open Schedule</RouterLink>
									<RouterLink class="button secondary" to="/guide">View Guide</RouterLink>
									<RouterLink class="button secondary" to="/channels">View Channels</RouterLink>
									<button class="button ghost" type="button" @click="closeSetup"><RotateCcw :size="17" />Start Another</button>
								</div>
							</section>
							<section v-else class="quick-step quick-missing-state"><WandSparkles :size="32" /><h2>Choose a valid setup path</h2><button class="button" type="button" @click="closeSetup">Start over</button></section>
						</Transition>
					</div>
				</div>
				<div id="quick-setup-actions" class="quick-setup-footer"></div>
			</section>
		</div>
	</section>
</template>
