<script setup lang="ts">
import { useDisclosureState } from './disclosure-state';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
	CalendarDays,
	CalendarRange,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	CircleGauge,
	BookOpen,
	FileCode,
	FileText,
	LayoutGrid,
	Library,
	ListVideo,
	LogOut,
	Menu,
	Settings,
	TvMinimal,
	TvMinimalPlay,
	WandSparkles,
	X,
} from '@lucide/vue';
import type { PlaybackEngineStatus } from '@moirai/shared';
import logoUrl from './assets/moirai-logo.png';
import { api } from './api';
import ConfirmationModal from './components/ConfirmationModal.vue';
import HelpDrawer from './components/HelpDrawer.vue';
import { activeConfirmation, cancelConfirmations, settleConfirmation } from './confirmation';
import { activeHelpTopic, closeHelp } from './help';
import { confirmSignOut } from './draft-protection';
import { liveEvents } from './live-events';
import { clearMediaCardPreviewCache } from './media-card-preview';
import { applicationError, clearApplicationError } from './application-error';
import { useLibrariesStore } from './stores/libraries';
import { useChannelsStore } from './stores/channels';
import { useAuthenticationStore } from './stores/authentication';
import ApplicationErrorPage from './views/ApplicationErrorPage.vue';

const route = useRoute();
const router = useRouter();
const libraryStore = useLibrariesStore();
const channelsStore = useChannelsStore();
const authentication = useAuthenticationStore();
const { libraries, loaded } = storeToRefs(libraryStore);
const { channels, loaded: channelsLoaded, publicUrlStatus } = storeToRefs(channelsStore);
const drawerOpen = ref(false);
const mobileViewport = window.matchMedia('(max-width: 900px)');
const isMobile = ref(mobileViewport.matches);

/** Release mobile navigation ownership when crossing the desktop breakpoint. */
function updateViewport(): void {
	isMobile.value = mobileViewport.matches;
	drawerOpen.value = false;
	if (isMobile.value && document.activeElement?.closest('.sidebar')) {
		void nextTick(() => document.querySelector<HTMLButtonElement>('.mobile-menu-button')?.focus());
	}
}
const libraryNavOpen = useDisclosureState('navigation-libraries', true);
const scheduleNavOpen = useDisclosureState('navigation-scheduling', true);
const playbackNavOpen = useDisclosureState('navigation-playback', true);
const playback = ref<PlaybackEngineStatus | null>(null);

const playbackLabel = computed(() => {
	if (!playback.value) {
		return 'Checking playback…';
	}

	return playback.value.status === 'ready' ? 'IPTV service ready' : 'Playback degraded';
});

const playbackDetail = computed(() => {
	if (!playback.value) {
		return 'Loading status';
	}

	const noun = playback.value.activeSessionCount === 1 ? 'stream' : 'streams';
	return `${playback.value.activeSessionCount}/${playback.value.maxActiveSessions} ${noun} active`;
});
const highlightQuickSetup = computed(() => channelsLoaded.value && channels.value.length === 0);

/** Load integrated playback state from the authoritative source. */
async function loadPlaybackState(): Promise<void> {
	try {
		playback.value = await api.playbackStatus();
	}
	catch {
		playback.value = null;
	}
}

/** Stop drawer and release resources held by the app workflow. */
function closeDrawer(): void {
	drawerOpen.value = false;
}

/** Load authenticated shell data only after an administrator session exists. */
function loadAdministrativeState(): void {
	void libraryStore.load();
	void channelsStore.loadChannels().catch(() => undefined);
	void channelsStore.loadCapabilities().catch(() => undefined);
	void loadPlaybackState();
}

/** Revoke the current local session and continue through provider logout when available. */
async function logout(): Promise<void> {
	if (!await confirmSignOut()) {
		return;
	}
	const redirectUrl = await authentication.logout();
	if (redirectUrl) {
		window.location.assign(redirectUrl);
		return;
	}

	await router.replace('/login');
}

/** Close the mobile navigation drawer when Escape is pressed. */
function handleKeydown(event: KeyboardEvent): void {
	if (event.key === 'Escape' && !event.defaultPrevented) {
		closeDrawer();
	}
}

const unsubscribe = liveEvents.subscribe((event) => {
	if (
		event.type === 'system.ready'
		|| event.type === 'library.changed'
		|| (event.type === 'scan.changed' && event.data.status !== 'running')
	) {
		libraryStore.scheduleRefresh();
	}
	if (
		event.type === 'system.ready'
		|| event.type === 'playback.changed'
	) {
		void loadPlaybackState();
	}
	if (event.type === 'system.ready') {
		void channelsStore.loadChannels().catch(() => undefined);
	}
});

watch(
	() => route.fullPath,
	() => {
		closeDrawer();
		closeHelp();
		cancelConfirmations();
		clearApplicationError();
	},
);
onMounted(() => {
	window.addEventListener('keydown', handleKeydown);
	mobileViewport.addEventListener('change', updateViewport);
	if (authentication.authenticated) {
		loadAdministrativeState();
	}
});
watch(
	() => authentication.authenticated,
	(value) => {
		if (value) {
			loadAdministrativeState();
		}
		else {
			clearMediaCardPreviewCache();
		}
	},
);
onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
	mobileViewport.removeEventListener('change', updateViewport);
	unsubscribe();
});
</script>

<template>
	<RouterView v-if="!authentication.authenticated" />
	<div v-else class="app-shell">
		<header class="mobile-header">
			<RouterLink class="mobile-brand" to="/" aria-label="Moirai home">
				<img :src="logoUrl" alt="" />
				<span>Moirai</span>
			</RouterLink>
			<button
				class="mobile-menu-button"
				aria-label="Open navigation"
				aria-controls="primary-sidebar"
				:aria-expanded="drawerOpen"
				@click="drawerOpen = true"
			>
				<Menu :size="22" />
			</button>
		</header>

		<Transition name="sidebar-backdrop">
			<button
				v-if="drawerOpen"
				class="sidebar-backdrop"
				aria-label="Close navigation"
				@click="closeDrawer"
			></button>
		</Transition>
		<aside id="primary-sidebar" v-modal-focus="{ active: isMobile && drawerOpen, navigation: true, escape: closeDrawer }" :inert="isMobile && !drawerOpen" class="sidebar" :class="{ 'sidebar-open': drawerOpen }">
			<div class="sidebar-heading">
				<RouterLink class="brand" to="/">
					<img :src="logoUrl" alt="" />
					<span><strong>Moirai</strong><small>IPTV Scheduler</small></span>
				</RouterLink>
				<button class="sidebar-close" aria-label="Close navigation" @click="closeDrawer">
					<X :size="20" />
				</button>
			</div>

			<nav class="primary-nav" aria-label="Primary navigation">
				<RouterLink class="nav-link status-nav-link" :class="`playback-${playback?.status ?? 'loading'}`" to="/" aria-live="polite">
					<CircleGauge :size="18" /><span><strong>Status</strong><small>{{ playbackLabel }}</small><small>{{ playbackDetail }}</small></span>
				</RouterLink>
				<div class="nav-spacer" aria-hidden="true"></div>
				<RouterLink class="nav-link" :class="{ 'quick-setup-nav-highlight': highlightQuickSetup }" to="/quick">
					<WandSparkles :size="18" /><span>Quick Setup</span>
				</RouterLink>
				<div class="nav-spacer" aria-hidden="true"></div>
				<RouterLink class="nav-link" to="/guide">
					<CalendarDays :size="18" /><span>Guide</span>
				</RouterLink>
				<RouterLink class="nav-link" to="/channels"
				><TvMinimal :size="18" /><span>Channels</span></RouterLink
				>
				<div class="nav-section">
					<div class="nav-section-heading">
						<RouterLink class="nav-link nav-section-link" to="/schedules/channels">
							<CalendarRange :size="18" /><span>Scheduling</span>
						</RouterLink>
						<button
							class="nav-section-toggle"
							:aria-expanded="scheduleNavOpen"
							aria-label="Toggle schedule navigation"
							@click="scheduleNavOpen = !scheduleNavOpen"
						>
							<ChevronDown :size="16" :class="{ rotated: !scheduleNavOpen }" />
						</button>
					</div>
					<Transition name="moirai-collapse">
						<div v-show="scheduleNavOpen" class="library-nav">
							<RouterLink class="library-nav-link" to="/schedules/channels">
								<span class="library-nav-icon"><TvMinimalPlay :size="16" /></span>
								<span>Channel Schedules</span>
							</RouterLink>
							<RouterLink class="library-nav-link" to="/schedules/templates">
								<span class="library-nav-icon"><CalendarRange :size="16" /></span>
								<span>Templates</span>
							</RouterLink>
							<RouterLink class="library-nav-link" to="/schedules/programs">
								<span class="library-nav-icon"><ListVideo :size="16" /></span>
								<span>Programs</span>
							</RouterLink>
						</div>
					</Transition>
				</div>

				<div class="nav-section">
					<div class="nav-section-heading">
						<RouterLink class="nav-link nav-section-link" to="/libraries">
							<Library :size="18" /><span>Libraries</span>
						</RouterLink>
						<button
							v-if="!loaded || libraries.length > 0"
							class="nav-section-toggle"
							:aria-expanded="libraryNavOpen"
							aria-label="Toggle configured libraries"
							@click="libraryNavOpen = !libraryNavOpen"
						>
							<ChevronDown :size="16" :class="{ rotated: !libraryNavOpen }" />
						</button>
					</div>
					<Transition name="moirai-collapse">
						<div v-if="!loaded || libraries.length > 0" v-show="libraryNavOpen" class="library-nav">
							<RouterLink
								v-for="library in libraries"
								:key="library.id"
								:to="`/libraries/${library.id}`"
								class="library-nav-link"
							>
								<span class="library-nav-icon"><LayoutGrid :size="16" /></span>
								<span>{{ library.name }}</span>
							</RouterLink>
							<span v-if="!loaded" class="library-nav-empty">Loading libraries…</span>
						</div>
					</Transition>
				</div>

				<div class="nav-section">
					<div class="nav-section-heading">
						<RouterLink class="nav-link nav-section-link" to="/playback"><TvMinimalPlay :size="18" /><span>Playback</span></RouterLink>
						<button class="nav-section-toggle" :aria-expanded="playbackNavOpen" aria-label="Toggle playback navigation" @click="playbackNavOpen = !playbackNavOpen"><ChevronDown :size="16" :class="{ rotated: !playbackNavOpen }" /></button>
					</div>
					<Transition name="moirai-collapse"><div v-show="playbackNavOpen" class="library-nav">
						<RouterLink class="library-nav-link" to="/playback/credit-templates"><span class="library-nav-icon"><FileText :size="16" /></span><span>Credit Templates</span></RouterLink>
						<RouterLink class="library-nav-link" to="/playback/encoding-profiles"><span class="library-nav-icon"><Settings :size="16" /></span><span>Encoding Profiles</span></RouterLink>
						<RouterLink class="library-nav-link" to="/playback/guide-templates"><span class="library-nav-icon"><FileCode :size="16" /></span><span>Guide Templates</span></RouterLink>
					</div></Transition>
				</div>
				<RouterLink class="nav-link" to="/settings"
				><Settings :size="18" /><span>Settings</span></RouterLink
				>
				<RouterLink class="nav-link" to="/logs"
				><FileText :size="18" /><span>Logs</span></RouterLink
				>
			</nav>

			<footer class="sidebar-footer">
				<a class="nav-link" href="/help/" target="_blank" rel="noopener" title="Open User Guide in a new tab"><BookOpen :size="18" /><span>User Guide</span></a>
				<div class="sidebar-account">
					<RouterLink class="sidebar-account-link" to="/account">
						<span>
							<small>Signed in via {{ authentication.state?.identity?.provider }}</small>
							<strong>{{ authentication.state?.identity?.displayName }}</strong>
						</span>
						<ChevronRight :size="16" />
					</RouterLink>
					<button class="icon-button" aria-label="Sign out" @click="logout">
						<LogOut :size="17" />
					</button>
				</div>
			</footer>
		</aside>

		<main class="app-content">
			<div v-if="publicUrlStatus === 'unreachable-default'" class="public-url-warning" role="alert">
				<CircleAlert :size="19" />
				<span>
					<strong>Public URL is only reachable from this machine.</strong>
					Set <code>MOIRAI_PUBLIC_URL</code> to an address your IPTV clients can reach.
				</span>
			</div>
			<ApplicationErrorPage v-if="applicationError" />
			<RouterView v-else />
		</main>
	</div>
	<HelpDrawer v-if="activeHelpTopic" :topic-id="activeHelpTopic" @close="closeHelp" />
	<ConfirmationModal
		v-if="activeConfirmation"
		:key="activeConfirmation.instanceId"
		:title="activeConfirmation.title"
		:message="activeConfirmation.message"
		:confirm-label="activeConfirmation.confirmLabel"
		:cancel-label="activeConfirmation.cancelLabel ?? 'Cancel'"
		:destructive="activeConfirmation.destructive"
		:required-text="activeConfirmation.requiredText"
		:required-text-label="activeConfirmation.requiredTextLabel"
		:alternate-label="activeConfirmation.alternateLabel"
		:alternate-destructive="activeConfirmation.alternateDestructive"
		@cancel="settleConfirmation('cancel')"
		@alternate="settleConfirmation('alternate')"
		@confirm="settleConfirmation('confirm')"
	/>
</template>
