import { guideLayout, statusLayout, logSpecimen } from './domain-layouts.mjs';
import { programEditor } from './program-reference.mjs';
import { subtitlePreferences, audioPreferences, encodingPreferences } from './preferences.mjs';
import { disclosure } from './form-disclosure.mjs';
import { helpButton } from './help.mjs';
import { sidebar } from './shell.mjs';
export { sidebar } from './shell.mjs';
import { libraryCollection, libraryStatus } from './library.mjs';
import { programCatalog, programToolbar, scheduleCatalog } from './current-patterns.mjs';
import { settingsLayout } from './settings.mjs';
import { actionIcon, field, icon, inspector, select } from './fixtures.mjs';

/** Reuse PageHelpButton's title-adjacent affordance with a local reference guide link. */
export function pageHelp(label) {
	return helpButton(label);
}

/** Compose a page header and optional primary task. */
function header(title, description, action = '', eyebrow = '') {
	return `<header class="page-header"><div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}<div class="current-title-help"><h1>${title}</h1>${['Settings', 'Status', 'Logs'].includes(title) ? '' : pageHelp(title, title === 'Programs' ? 'programs' : 'scheduling')}</div><p>${description}</p></div>${action ? `<button class="primary" data-reference-new-program data-app-path="/schedules/programs/new"><span class="action-glyph action-plus" aria-hidden="true"></span><span>${action}</span></button>` : ''}</header>`;
}

/** Render grouped editor fields shared by the full layout and working dialog. */
export function editorFields() {
	return `<section class="stack"><div class="current-channel-identity">${field('Number', '24', 'text', 'channel-number')}${field('Name', 'Night flight', 'text', 'channel-name')}<label>Group<input id="channel-group" type="text" list="channel-group-suggestions" value="Movies"><datalist id="channel-group-suggestions"><option value="Movies"></option><option value="Documentaries"></option></datalist></label></div><div class="reference-channel-schedule"><span>Schedule</span><a class="button" href="?layout=schedules" data-channel-schedule>Manage Layered Schedule</a><button type="button" disabled data-channel-schedule-disabled hidden>Manage Layered Schedule</button><small data-channel-schedule-note hidden>Save the channel before configuring its schedule.</small></div><section class="reference-channel-logo"><header><strong>Channel logo</strong><small>PNG on save · maximum 1920×1080</small></header><div class="row"><span class="current-logo-placeholder">${icon('image-plus')}</span><div class="stack tight"><button type="button" data-logo-pick>${actionIcon('upload')}Choose Image</button><input type="file" accept="image/*" hidden aria-label="Channel logo file"><p class="small muted">JPEG, PNG, WebP, or another browser-supported image up to 25 MiB.</p></div></div></section></section>${subtitlePreferences()}${audioPreferences()}${encodingPreferences()}${disclosure('Guide template override', 'Use a specific XMLTV template for this channel', 'file-code', `<div class="stack">${select('XMLTV layout', ['Default (Default guide template)', 'Film listings'])}<a class="button" href="./docs/audit.md" data-app-path="/playback/guide-templates">Manage Guide Templates</a><p>Unset channels use the default XMLTV template.</p></div>`)}${disclosure('Channel fallback override', 'Use a fallback video just for this channel', 'video', '<div class="stack"><p>Effective global fallback: Bundled Moirai fallback</p><label>Replacement video<input type="file" accept="video/*"></label><label class="check"><input type="checkbox">Remove override on save</label></div>')}`;
}

/** Render an editor with stable header, scrolling body, and persistent action bar. */
export function editorSurface() {
	return `<form class="editor-surface channel-reference-editor" data-editor-form novalidate><header class="editor-header"><div><span class="eyebrow">Edit channel</span><div class="current-title-help"><h2 id="editor-title">Edit Channel</h2>${pageHelp('Channels', 'overlays')}</div></div><label class="check current-enabled"><span>On</span><input type="checkbox" class="switch" role="switch" aria-label="Channel enabled" checked></label><button type="button" class="icon ghost" aria-label="Close channel editor" data-editor-close>${actionIcon('x')}</button></header><div class="editor-body">${editorFields()}<p class="error" id="editor-error" data-editor-error role="alert" hidden></p></div><footer class="editor-footer"><button type="button" class="danger" data-delete><span class="action-glyph action-trash-2" aria-hidden="true"></span><span>Delete Channel</span></button><div class="row"><button type="button" data-reset data-confirm-label="Confirm reset channel draft" data-confirm-text="Reset" disabled>Reset</button><button type="button" data-save>Close</button></div></footer></form>`;
}

/** Render the representative product layouts without application dependencies. */
export function pageLayout(id) {
	if (id === 'program-editor') {
		return `<main class="dialog-stage">${programEditor()}</main>`;
	}
	if (id === 'editor' || id === 'mobile-editor') {
		return `<main class="dialog-stage">${editorSurface()}</main>`;
	}

	const mobile = id === 'mobile-catalog';
	const active = mobile ? 'catalog' : id;
	const pages = {
		status: `${header('Status', 'Monitor the media index, channel configuration, and integrated IPTV service.', '', 'System status')}${statusLayout()}`,
		logs: `${header('Logs', 'Inspect application events and retained log files.')}${logSpecimen(false)}`,
		catalog: `${header('Programs', 'Programs define how eligible media is selected and arranged. Reuse them across multiple schedules and channels.', 'New Program', 'Reusable content rules')}<div class="workspace"><div class="stack">${programToolbar()}${programCatalog()}</div>${inspector()}</div>`,
		library: `<header class="page-header current-library-header"><div><span class="eyebrow">Libraries</span><div class="current-title-help"><h1>Film library</h1>${pageHelp('Libraries', 'media')}</div></div><div class="row"><button class="icon" aria-label="Sync library">${icon('refresh-cw')}</button><button class="icon" aria-label="Library settings">${icon('settings-2')}</button><label class="current-library-search">${icon('search')}<span class="sr-only">Search Film library</span><input type="search" placeholder="Search title, plot, genre, actor, director…"><kbd>⌘ K</kbd></label></div></header>${libraryStatus()}${libraryCollection()}`,
		schedules: `${header('Channel Schedules', 'Choose a channel to configure its base and conditional programming layers.', '', 'Layered channel programming')}${scheduleCatalog()}`,
		guide: `${header('Guide', 'Review the resolved channel lineup and connect IPTV clients to Moirai.', '', 'Electronic program guide')}${guideLayout()}`,
		settings: `${header('Settings', 'Manage playback, content selection, and backups.', '', 'Application settings')}${settingsLayout()}`,
	};
	const mobileContent = `${header('Programs', 'Programs define how eligible media is selected and arranged.', 'New Program', 'Reusable content rules')}<div class="workspace"><div class="stack">${programToolbar()}${programCatalog()}</div></div>`;

	return `<div class="app-shell">${sidebar(active)}<div><header class="mobile-bar"><a class="current-mobile-brand" href="?layout=catalog"><img src="./assets/moirai-logo.png" alt="">Moirai</a><button class="icon" aria-label="Open navigation" aria-expanded="false" data-navigation>${icon('menu')}</button></header><main class="app-main ${active === 'library' ? 'current-library-page' : ''}">${mobile ? mobileContent : pages[active]}</main></div></div>`;
}
