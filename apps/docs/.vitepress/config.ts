import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { userDocsIntroductions } from '../../../scripts/user-docs-introductions';
import { userDocsTermBadges } from '../../../scripts/user-docs-term-badges';
import { reviewSidebar } from '../../../scripts/user-docs-sidebar';
import reviewManifest from '../src/public/contextual-help.json';
import { userDocsHighlights } from '../../../scripts/user-docs-highlights';

export default defineConfig({
	title: 'Moirai User Guide',
	description: 'Set up, schedule, and operate Moirai without needing to know its internals.',
	base: '/help/',
	srcDir: 'src',
	outDir: fileURLToPath(new URL('../dist/', import.meta.url)),
	appearance: 'dark',
	lastUpdated: true,
	markdown: {
		config: (markdown) => markdown.use(userDocsTermBadges).use(userDocsIntroductions).use(userDocsHighlights, reviewManifest.pages),
	},
	ignoreDeadLinks: false,
	head: [
		['meta', { name: 'theme-color', content: '#06101a' }],
		['meta', { name: 'color-scheme', content: 'dark' }],
	],
	themeConfig: {
		lastUpdated: {
			formatOptions: { dateStyle: 'short' },
		},
		logo: '/help/moirai-logo.png',
		siteTitle: false,
		socialLinks: [
			{ icon: 'github', link: 'https://github.com/moiraitv/moirai/', ariaLabel: 'Moirai on GitHub' },
		],
		nav: [
			{ text: 'Guide', link: '/' },
			{ text: 'Review status', link: '/review' },
		],
		sidebar: reviewSidebar([
			{
				text: 'Start here',
				items: [
					{ text: 'Welcome', link: '/' },
					{ text: 'Glossary and terminology', link: '/glossary' },
					{ text: 'Install with Docker', link: '/getting-started/docker' },
					{ text: 'Administrator access', link: '/getting-started/access' },
					{ text: 'Create your first channel', link: '/getting-started/first-channel' },
				],
			},
			{
				text: 'Media libraries',
				items: [
					{ text: 'Libraries and scanning', link: '/libraries/managing-libraries' },
					{ text: 'Media file naming', link: '/libraries/media-file-naming' },
					{ text: 'Browse and filter media', link: '/libraries/browsing-media' },
					{ text: 'Missing media and conflicts', link: '/libraries/reconciliation' },
				],
			},
			{
				text: 'Build a schedule',
				items: [
					{ text: 'Programs', link: '/scheduling/programs' },
					{ text: 'Templates', link: '/scheduling/templates' },
					{ text: 'Channel schedules', link: '/scheduling/channel-schedules' },
					{ text: 'Channels', link: '/scheduling/channels' },
				],
			},
			{
				text: 'Playback',
				items: [
					{ text: 'Encoding profiles', link: '/playback/encoding-profiles' },
					{ text: 'Credit templates', link: '/playback/credit-templates' },
				],
			},
			{
				text: 'Watch and operate',
				items: [
					{ text: 'Guide and IPTV clients', link: '/playback/guide-and-clients' },
					{ text: 'Playback settings', link: '/playback/settings' },
					{ text: 'Status and logs', link: '/operations/status-and-logs' },
					{ text: 'Account and recovery', link: '/operations/account-and-recovery' },
					{ text: 'Troubleshooting', link: '/operations/troubleshooting' },
					{ text: 'Configuration reference', link: '/operations/configuration' },
				],
			},
		], reviewManifest.pages),
		search: { provider: 'local' },
		footer: {
			message: 'Bundled with this version of Moirai.',
		},
	},
});
