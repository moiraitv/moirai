import { actionIcon, icon, mediaCards } from './fixtures.mjs';

/** Preserve LibraryPage's alphabet navigation and adjacent sort/filter/selection actions. */
export function libraryToolbar() {
	return `<div class="current-library-toolbar"><div class="current-alphabet" role="group" aria-label="Catalog navigation">${'#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `<button type="button" data-library-letter="${letter}" ${'ABCEGHL'.includes(letter) ? '' : 'disabled'}>${letter}</button>`).join('')}</div><button type="button" class="current-library-sort" data-library-sort aria-expanded="false" aria-controls="library-sort-menu"><span>Sort by: Title A–Z</span><span class="current-sort-caret" aria-hidden="true"></span></button><button type="button" class="icon current-library-tool" aria-label="Filter media" title="Filter media" data-library-filter>${icon('funnel')}</button><button type="button" class="icon current-library-tool" data-media-mode data-media-mode-icon aria-label="Select items" title="Select items" aria-pressed="false">${actionIcon('list-plus')}</button></div>`;
}

/** Render the source-shaped collection, including its persistent one-page fixture footer. */
export function libraryCollection() {
	return `<section class="stack current-library-collection" data-media-collection>${libraryToolbar()}<div class="current-library-bulk" data-media-bulk hidden role="toolbar" aria-label="Item selection"><div class="row"><strong data-media-count data-count-compact role="status">0 selected</strong><button type="button" data-media-add-selected disabled>${actionIcon('list-plus')}<span>Add Selected</span></button><button type="button" data-media-add-all>${icon('layers-3')}<span>Add All</span></button></div><button type="button" data-media-select-page>Select Page</button></div>${mediaCards(8)}<footer class="current-library-footer"><span>Showing 1–8 of 8</span><div class="current-library-pagination" role="group" aria-label="Pagination"><button type="button" disabled aria-label="Previous page">${icon('chevron-left')}</button><button type="button" aria-current="page">1</button><button type="button" disabled aria-label="Next page">${icon('chevron-right')}</button></div><span>100 per page</span></footer></section><div id="library-sort-menu" popover class="popover-sample menu-live" aria-label="Sort media"><button type="button" data-library-order="Title">${icon('list-ordered')}<span>Title</span></button><button type="button" data-library-order="Date Added">${icon('clock-3')}<span>Date Added</span></button><button type="button" data-library-order="Genre">${icon('rows-3')}<span>Genre</span></button><hr><button type="button" data-library-reverse>${icon('arrow-down-az')}<span>Reverse Order</span></button></div>`;
}

/** Keep all five existing status sections, their icons and the scan-history disclosure. */
export function libraryStatus() {
	const stat = (label, value, note, glyph, tone, linked = false) => {
		const content = `<span class="current-status-icon ${tone}">${actionIcon(glyph)}</span><div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>${linked ? icon('chevron-right') : ''}`;
		return linked ? `<button type="button" class="current-library-stat current-status-history" aria-label="Last scan: open scan history" aria-haspopup="dialog" data-scan-history>${content}</button>` : `<div class="current-library-stat">${content}</div>`;
	};
	return `<section class="current-library-status panel" aria-label="Library status">${stat('Watcher', 'Watching', 'Monitoring library', 'circle-check', 'success')}${stat('Scan status', 'Completed', 'No scan in progress', 'refresh-cw', 'info')}${stat('Indexed', '8', 'Movies', 'layers-3', 'purple')}${stat('Last scan', 'Today, 18:00', '12 minutes ago', 'clock-3', 'warning', true)}${stat('Last change', 'Today, 17:58', '14 minutes ago', 'zap', 'info')}</section>`;
}
