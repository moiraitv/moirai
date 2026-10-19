/** Component families used by the handbook, gallery, and screenshot capture. */
export const families = [
	['foundations', 'Foundations', 'The quiet workbench', 'Color, type, spacing, shape, depth, icons and motion.'],
	['navigation', 'Navigation & structure', 'A familiar place to work', 'Shell, navigation, headers, tabs, panels and disclosures.'],
	['actions', 'Actions', 'A clear next step', 'Buttons, links, icon actions and interaction states.'],
	['fields', 'Text & selection fields', 'Make the expected input clear', 'Text, numbers, descriptions, selects, comboboxes and validation.'],
	['choices', 'Choice controls', 'Clear choices, explicit outcomes', 'Detailed selection cards, checkboxes, switches, radio groups, sliders and segments.'],
	['search', 'Search & filtering', 'Find without losing context', 'Search, facets, active filters, sorting and bulk actions.'],
	['collections', 'Collections', 'Read, compare, select', 'Tables, rows, selection, sort order and pagination.'],
	['media', 'Media & artwork', 'Content is the focal point', 'Artwork, cards, selection, fallbacks and preview surfaces.'],
	['metadata', 'Metadata & inspectors', 'Details at the right depth', 'Badges, statuses, metadata lists and selected-resource inspectors.'],
	['feedback', 'Feedback & async states', 'Always explain what is happening', 'Loading, empty, failed, populated, progress, banners and toasts.'],
	['overlays', 'Overlays & contextual help', 'Keep the task in focus', 'Menus, tooltips, popovers, dialogs, drawers and confirmations.'],
	['editor', 'Resource editors', 'Protect the work in progress', 'Headers, grouped fields, protected dismissal and persistent actions.'],
	['scheduling', 'Guide & scheduling', 'Make time and precedence legible', 'Timelines, guide blocks, layers, overrides and warnings.'],
	['programs', 'Program composition', 'Show how content is assembled', 'Sources, authored sequences, selection review and playback preferences.'],
	['operations', 'Playback & operations', 'Readable status without noise', 'Now playing, resource metrics, progress and structured logs.'],
].map(([id, title, heading, description]) => ({ id, title, heading, description }));

/** Complete compositions and their reference viewport widths. */
export const layouts = [
	{ id: 'status', title: 'Status', width: 1440, height: 1000 },
	{ id: 'logs', title: 'Logs', width: 1440, height: 1000 },
	{ id: 'catalog', title: 'Program catalog', width: 1440, height: 1000 },
	{ id: 'library', title: 'Film library', width: 1440, height: 1000 },
	{ id: 'guide', title: 'Guide', width: 1440, height: 1000 },
	{ id: 'program-editor', title: 'Sequence Program editor', width: 1440, height: 1000 },
	{ id: 'schedules', title: 'Channel Schedules', width: 1440, height: 1000 },
	{ id: 'editor', title: 'Channel editor', width: 1440, height: 1000 },
	{ id: 'settings', title: 'Settings', width: 1440, height: 1000 },
	{ id: 'mobile-catalog', title: 'Mobile catalog', width: 390, height: 844 },
	{ id: 'mobile-editor', title: 'Mobile editor', width: 390, height: 844 },
];
