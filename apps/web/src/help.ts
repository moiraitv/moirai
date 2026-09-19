import { ref } from 'vue';

/** Stable topic identifiers that every application route mapping must resolve in the bundled guide. */
export const helpTopicIds = [
	'getting-started.first-channel',
	'operations.status',
	'playback.guide',
	'libraries.browse',
	'libraries.manage',
	'channels.manage',
	'scheduling.programs',
	'playback.credit-templates',
	'playback.guide-templates',
	'playback.encoding-profiles',
	'scheduling.templates',
	'scheduling.channel-schedules',
	'playback.settings',
	'operations.account',
	'welcome',
] as const;

/** Stable user-guide topic currently presented over the application. */
export const activeHelpTopic = ref<string | null>(null);

/** Present one contextual user-guide topic. */
export function openHelp(topicId: string): void {
	activeHelpTopic.value = topicId;
}

/** Dismiss contextual help without changing the underlying route. */
export function closeHelp(): void {
	activeHelpTopic.value = null;
}

/** Select the most specific help topic for one management route. */
export function helpTopicForPath(pathname: string): string {
	if (pathname === '/quick') {
		return 'getting-started.first-channel';
	}
	if (pathname === '/') {
		return 'operations.status';
	}
	if (pathname.startsWith('/guide')) {
		return 'playback.guide';
	}
	if (/^\/libraries\/[^/]+\/items\//u.test(pathname)) {
		return 'libraries.browse';
	}
	if (pathname.startsWith('/libraries/')) {
		return 'libraries.browse';
	}
	if (pathname.startsWith('/libraries')) {
		return 'libraries.manage';
	}
	if (pathname.startsWith('/channels')) {
		return 'channels.manage';
	}
	if (pathname.startsWith('/playback/credit-templates')) {
		return 'playback.credit-templates';
	}
	if (pathname.startsWith('/playback/guide-templates')) {
		return 'playback.guide-templates';
	}
	if (pathname.startsWith('/playback')) {
		return 'playback.encoding-profiles';
	}
	if (pathname.startsWith('/schedules/programs')) {
		return 'scheduling.programs';
	}
	if (pathname.startsWith('/schedules/templates')) {
		return 'scheduling.templates';
	}
	if (pathname.startsWith('/schedules')) {
		return 'scheduling.channel-schedules';
	}
	if (pathname.startsWith('/settings')) {
		return 'playback.settings';
	}
	if (pathname.startsWith('/logs')) {
		return 'operations.status';
	}
	if (pathname.startsWith('/account')) {
		return 'operations.account';
	}
	return 'welcome';
}
