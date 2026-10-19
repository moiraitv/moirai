import { confirmationMark } from './two-step.mjs';
import { media } from './media-fixtures.mjs';

/** Fictional content shared by all reference compositions. */
export const programs = [
	['Evening cinema', 'Feature films after dark', 'Content', '24', '48h 20m', 'blue'],
	['Weekend discoveries', 'Independent voices', 'Sequence', '18', '36h 10m', 'amber'],
	['Night flight', 'Stories for the late hours', 'Similar Items', '32', '62h 15m', 'violet'],
	['Documentary hour', 'A closer look at our world', 'Content', '28', '54h 00m', 'green'],
	['Field notes', 'Nature and discovery', 'Content', '46', '72h 40m', 'green'],
	['After hours', 'Music, culture and conversation', 'Sequence', '16', '28h 30m', 'violet'],
	['The long weekend', 'A slower kind of Saturday', 'Content', '36', '64h 50m', 'amber'],
	['Northern light', 'Journeys beyond the familiar', 'Theme', '22', '41h 10m', 'blue'],
];

/** Render a licensed local Lucide outline from the copied SVG files. */
export function icon(name = 'list-video') {
	return `<img class="lucide" src="./assets/icons/${name}.svg" alt="" width="20" height="20">`;
}

/** Render an unchanged documentation fixture poster in a stable portrait frame. */
export function poster(item, mini = false) {
	return `<div class="poster${mini ? ' poster-mini' : ''}"><img src="./assets/media/${item.poster}" alt=""></div>`;
}

/** Render a labeled editable field with an optional stable ID. */
export function field(label, value, type = 'text', id = '') {
	return `<label>${label}<input ${id ? `id="${id}"` : ''} type="${type}" value="${value}"></label>`;
}

/** Render a dropdown with a visible label. */
export function select(label, options) {
	return `<label>${label}<span class="select-control"><select>${options.map(value => `<option>${value}</option>`).join('')}</select></span></label>`;
}

/** Render both source-owned card affordances; the collection mode exposes only one. */
export function mediaCards(count = 8, bulk = false) {
	return `<div class="cards">${media.slice(0, count).map((item, index) => `<article class="media-card ${bulk && index === 0 ? 'selected' : ''}"><a class="media-primary" href="./components/media.md#preview-and-adaptation" data-app-path="/libraries/film/items/fixture-${index}" ${bulk ? 'tabindex="-1" aria-hidden="true"' : ''}>${poster(item)}<div class="media-card-copy"><h4 title="${item.title}">${item.title}</h4><p class="small muted">${item.year} · ${item.genre}</p></div></a><button type="button" class="media-add" aria-label="Add ${item.title} to a program" data-media-title="${item.title}" ${bulk ? 'hidden' : ''}><span class="media-card-affordance">${actionIcon('plus')}</span></button><button type="button" class="media-select" aria-label="${bulk && index === 0 ? 'Deselect' : 'Select'} ${item.title}" data-media-title="${item.title}" aria-pressed="${bulk && index === 0}" ${bulk ? '' : 'hidden'}><span class="media-card-affordance">${confirmationMark()}</span></button></article>`).join('')}</div>`;
}

/** Keep normal browsing and explicit bulk selection distinct in every library example. */
export function mediaCollection(count = 8, bulk = false) {
	return `<section class="stack media-collection" aria-label="Media collection" data-media-collection><div class="row between"><span class="small muted">${count} movies</span><button type="button" data-media-mode aria-pressed="${bulk}">${actionIcon(bulk ? 'x' : 'list-plus')}<span>${bulk ? 'Cancel selection' : 'Select items'}</span></button></div><div class="row between" data-media-bulk ${bulk ? '' : 'hidden'}><span class="pill success" data-media-count role="status">1 item selected</span><button type="button" class="primary" data-media-add-selected>${actionIcon('plus')}<span>Add to Program</span></button></div>${mediaCards(count, bulk)}</section>`;
}

/** Render program timing and channel names in a horizontally scrollable guide. */
export function timeline() {
	return `<div class="timeline-wrap" tabindex="0" role="region" aria-label="Guide timeline. Scroll horizontally for more times."><div class="timeline"><div class="timeline-header"><span>Channels</span>${[18, 19, 20, 21].map(hour => `<span><strong>Monday · Oct 19</strong><small>${hour}:00</small></span>`).join('')}</div>${['24 · Night flight', '25 · Field notes', '26 · After hours'].map((channel, row) => `<div class="timeline-row"><div class="channel-name">${icon('tv-minimal')}<strong>${channel}</strong></div>${[0, 1, 2, 3].map((slot) => `<button class="program-block" type="button" data-guide-slot data-guide-media="${(row * 3 + slot) % media.length}"><img class="guide-card-artwork" src="./assets/media/${media[(row * 3 + slot) % media.length].poster}" alt=""><span class="guide-card-copy"><strong>${media[(row * 3 + slot) % media.length].title}</strong><small>${18 + slot}:00–${19 + slot}:00</small></span></button>`).join('')}</div>`).join('')}</div></div>`;
}

/** ChannelScheduleCatalog places conditional assignments above its base fallback. */
export function layers() {
	return '<div class="stack"><div class="schedule-layer override"><div><span class="eyebrow">Conditional</span><h4>Weekend discoveries</h4><p class="small muted">Saturday and Sunday</p></div></div><div class="schedule-layer"><div><span class="eyebrow">Base</span><h4>Evening cinema</h4><p class="small muted">Used when no conditional layer supplies programming</p></div></div></div>';
}

/** Render ProgramInspector's type-specific details, actual reference usage and actions. */
export function inspector(index = 0) {
	const [name, , type, count] = programs[index];
	const definition = type === 'Content' ? 'Library Query' : type === 'Sequence' ? '2 Programs' : type === 'Theme' ? 'Prompt: Journeys beyond the familiar' : 'Based on “Evening cinema”';
	const details = type === 'Content' ? '<h3 class="eyebrow">Definition</h3><p>Film library · all matching items</p><dl class="metadata"><dt>Source Library</dt><dd>Film library</dd><dt>Selection</dt><dd>Shuffle</dd></dl>' : type === 'Sequence' ? '<h3 class="eyebrow">Sequence Configuration</h3><p>3 items per cycle</p><p>Ordered · Steps shown in authored order</p><ol><li><button data-inspect="0">Evening cinema · 2 Items</button></li><li><button data-inspect="2">Night flight · 1 Item</button></li></ol><p>Repeats after each cycle.</p>' : `<h3 class="eyebrow">Definition</h3>${type === 'Theme' ? '<h4>Prompt</h4><p>Journeys beyond the familiar</p><p>Source Library: Film library</p>' : '<h4>Source Program</h4><button data-inspect="0">Evening cinema</button>'}<h4>Generation settings</h4><dl class="metadata"><dt>Quantity</dt><dd>10</dd><dt>Cohesion / Variety</dt><dd>40 / 100</dd></dl><h4>Current sets</h4><p>No committed sets reported.</p><p class="small secondary">Each schedule use generates its next set automatically. Saved settings apply to future sets.</p>`;
	return `<aside class="panel stack inspector" aria-label="Selected program details" data-inspector="${index}"><header class="row between"><div><h2>${name}</h2><div class="row"><span class="pill ${type === 'Sequence' ? 'purple' : 'info'}">${type}</span><span class="small muted">${definition}</span></div></div><button class="icon inspector-close" aria-label="Close program inspector" data-inspector-close>${actionIcon('x')}</button></header><div class="inspector-content stack"><p class="small secondary"><span class="status-icon">●</span> Ready · ${count}/${count} available</p>${mediaCarousel(type === 'Sequence' ? 'Source preview' : ['Similar Items', 'Theme'].includes(type) ? 'Sample matches' : 'Media preview')}${details}<details open class="resource-reference-usage"><summary>${actionIcon('git-branch')}Used by</summary><p>This program is currently used by 2 resources.</p><a class="usage-reference" href="?layout=schedules">${icon('tv-minimal')}<span><strong>Night flight</strong><small>Channel · Base program · 1 reference</small></span>${icon('chevron-right')}</a><a class="usage-reference" href="?layout=schedules">${icon('tv-minimal')}<span><strong>After hours</strong><small>Channel · Conditional layer · 1 reference</small></span>${icon('chevron-right')}</a><p class="small secondary">Changes affect these direct references. Other channels may be affected indirectly.</p></details><p class="muted small">Updated Oct 19, 2026, 18:00</p></div><footer class="row between"><a class="button primary" href="${type === 'Sequence' ? '?layout=program-editor' : '?family=programs'}" data-app-path="/schedules/programs/fixture-${index}">${actionIcon('pencil')}<span>Edit Program</span></a><button class="icon" aria-label="Delete Program" data-program-delete>${icon('trash-2')}</button></footer></aside>`;
}

/** ActionMenu for Program rows contains the existing Edit and permanent Delete actions. */
export function menuItems() {
	return `<a href="?layout=program-editor" data-context-action="Edit Program">${actionIcon('pencil')}<span>Edit Program</span></a><hr><button type="button" class="danger" data-context-action="Delete Program">${actionIcon('trash-2')}<span>Delete Program</span></button>`;
}

/** Render a decorative action glyph that inherits the button's semantic text color. */
export function actionIcon(name) {
	return `<span class="action-glyph action-${name}" aria-hidden="true"></span>`;
}

/** Show existing Program strategy or sequence ordering choices with their explanatory copy. */
export function detailedChoices(sequence = false) {
	const choices = sequence ? [
		['ordered', 'Ordered', 'Play each step’s selections together, in the listed order.', 'list-ordered'],
		['shuffled-blocks', 'Shuffled blocks', 'Shuffle the steps each cycle, keeping each step’s selections together.', 'shuffle'],
		['shuffled-allocations', 'Shuffled allocations', 'Mix selections across steps while keeping each step’s count.', 'dices'],
		['balanced-rotation', 'Balanced rotation', 'Spread each step’s selections through the cycle, avoiding consecutive turns when possible.', 'rows-3'],
	] : [
		['sequential', 'Sequential', 'Follow the configured playback order, continuing where you left off', 'list-ordered'],
		['shuffle', 'Shuffle (no repeats)', 'Random order with no repeats until all have played', 'shuffle'],
		['random', 'Random', 'Choose a random item each time', 'dices'],
		['weighted-random', 'Weighted random', 'Prefer content your viewers have chosen while retaining variety', 'sparkles'],
	];
	const group = sequence ? 'sequence-ordering' : 'selection-strategy';
	return `<div class="detailed-choices" role="group" aria-label="${sequence ? 'Sequence ordering' : 'Selection strategy'}">${choices.map(([value, label, detail, glyph], index) => `<button type="button" class="choice-card" aria-pressed="${index === (sequence ? 0 : 1)}" aria-labelledby="${group}-${value}-label" aria-describedby="${group}-${value}-detail" data-detailed-choice="${value}"><span class="choice-indicator" aria-hidden="true"></span>${actionIcon(glyph)}<strong id="${group}-${value}-label">${label}</strong><span class="choice-detail" id="${group}-${value}-detail">${detail}</span></button>`).join('')}</div>`;
}

/** Preserve the current compact, horizontally scrolling Program preview pattern. */
export function mediaCarousel(label = 'Media preview', state = 'populated') {
	const populated = state === 'populated';
	const message = { loading: 'Loading media previews…', empty: 'No preview items available.', failed: 'Could not load media previews.' }[state];
	const cards = populated ? media.map(item => `<a class="preview-card" href="?layout=library" aria-label="${item.title}">${poster(item)}<strong title="${item.title}">${item.title}</strong><small>${item.year}</small></a>`).join('') : Array.from({ length: 5 }, () => '<div class="preview-card preview-placeholder"><div class="poster"></div><strong></strong><small></small></div>').join('');
	return `<section class="media-preview stack tight" data-preview-state="${state}" aria-label="${label}"><h4 class="eyebrow">${label}</h4><div class="preview-stage" aria-busy="${state === 'loading'}"><div class="media-carousel" ${populated ? `tabindex="0" role="region" aria-label="${label} carousel"` : 'inert aria-hidden="true"'}>${cards}</div>${populated ? '' : `<p class="preview-state-message ${state === 'failed' ? 'error' : ''}" role="${state === 'failed' ? 'alert' : 'status'}">${message}</p>`}</div></section>`;
}

/** Present source ordering as a shared right-edge handle with explicit boundary states. */
export function sequenceMoveHandle(title, atStart = false, atEnd = false) {
	return `<div class="sequence-moves" role="group" aria-label="Reorder ${title}"><button type="button" class="icon" aria-label="Move ${title} up" title="Move up" ${atStart ? 'disabled' : ''}>${actionIcon('arrow-up')}</button><button type="button" class="icon" aria-label="Move ${title} down" title="Move down" ${atEnd ? 'disabled' : ''}>${actionIcon('arrow-down')}</button></div>`;
}
