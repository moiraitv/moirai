import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import packageJson from '../../../package.json' with { type: 'json' };

export default defineConfig({
	title: 'Moirai User Guide',
	description: 'Set up, schedule, and operate Moirai without needing to know its internals.',
	base: '/help/',
	srcDir: 'src',
	outDir: fileURLToPath(new URL('../dist/', import.meta.url)),
	appearance: 'dark',
	lastUpdated: true,
	ignoreDeadLinks: false,
	head: [
		['meta', { name: 'theme-color', content: '#06101a' }],
		['meta', { name: 'color-scheme', content: 'dark' }],
	],
	themeConfig: {
		logo: '/help/moirai-logo.png',
		siteTitle: `Moirai ${packageJson.version}`,
		nav: [
			{ text: 'Guide', link: '/' },
			{ text: 'Review status', link: '/review' },
		],
		sidebar: [
			{
				text: 'Start here',
				items: [
					{ text: 'Welcome', link: '/' },
					{ text: 'Install with Docker', link: '/getting-started/docker' },
					{ text: 'Administrator access', link: '/getting-started/access' },
					{ text: 'Create your first channel', link: '/getting-started/first-channel' },
				],
			},
			{
				text: 'Media libraries',
				items: [
					{ text: 'Libraries and scanning', link: '/libraries/managing-libraries' },
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
				text: 'Watch and operate',
				items: [
					{ text: 'Guide and IPTV clients', link: '/playback/guide-and-clients' },
					{ text: 'Playback settings', link: '/playback/settings' },
					{ text: 'Status and logs', link: '/operations/status-and-logs' },
					{ text: 'Account and recovery', link: '/operations/account-and-recovery' },
					{ text: 'Troubleshooting', link: '/operations/troubleshooting' },
					{ text: 'Configuration reference', link: '/operations/configuration' },
					{ text: 'Glossary', link: '/glossary' },
				],
			},
		],
		search: { provider: 'local' },
		footer: {
			message: 'Bundled with this version of Moirai.',
		},
	},
});
