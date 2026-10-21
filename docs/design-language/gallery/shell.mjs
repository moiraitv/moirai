/* global document */
import { icon, actionIcon } from './fixtures.mjs';

/** Map source destinations to represented layouts or their local reference specifications. */
const destinations = {
	'/': ['status', 'operations'], '/quick': ['editor', 'editor'], '/guide': ['guide', 'scheduling'],
	'/channels': ['editor', 'editor'], '/schedules/channels': ['schedules', 'scheduling'],
	'/schedules/programs': ['catalog', 'programs'], '/libraries/film': ['library', 'media'],
	'/settings': ['settings', 'navigation'], '/logs': ['logs', 'operations'],
};

/** Preserve App.vue's navigation order, independent group links and footer ownership. */
export function sidebar(active = 'catalog', prefix = 'rail') {
	const link = (label, glyph, route, extra = '', tail = '') => {
		const target = destinations[route];
		const href = target ? `?layout=${target[0]}` : './docs/audit.md';
		return `<a class="${route === '/' ? 'status-nav-link' : ''}" href="${href}" data-app-path="${route}" ${target?.[0] === active && !['/quick', '/channels'].includes(route) ? 'aria-current="page"' : ''}>${actionIcon(glyph)}<span>${route === '/' ? `<strong>${label}</strong>` : label}${extra}</span>${tail}</a>`;
	};
	const group = (label, glyph, route, children) => `<section class="current-nav-group"><div class="current-nav-heading">${link(label, glyph, route)}<button type="button" class="icon" aria-label="Toggle ${label.toLowerCase()} navigation" aria-expanded="true" aria-controls="${prefix}-${label}" data-nav-toggle>${actionIcon('chevron-down')}</button></div><div class="current-nav-items" id="${prefix}-${label}">${children}</div></section>`;
	return `<aside class="sidebar" aria-label="Primary sidebar"><div class="brand"><img src="./assets/moirai-logo.png" alt=""><div><strong>Moirai</strong><small>IPTV Scheduler</small></div></div><nav aria-label="Primary navigation">${link('Status', 'circle-gauge', '/', '<small>IPTV service ready</small><small>2/4 streams active</small>')}<div class="current-nav-spacer" aria-hidden="true"></div>${link('Quick Setup', 'wand-sparkles', '/quick')}<div class="current-nav-spacer" aria-hidden="true"></div>${link('Guide', 'calendar-days', '/guide')}${link('Channels', 'tv-minimal', '/channels')}${group('Scheduling', 'calendar-range', '/schedules/channels', link('Channel Schedules', 'tv-minimal-play', '/schedules/channels') + link('Templates', 'calendar-range', '/schedules/templates') + link('Programs', 'list-video', '/schedules/programs'))}${group('Libraries', 'library', '/libraries', `${link('Film library', 'layout-grid', '/libraries/film', '', '<span class="dot library-nav-ready" role="img" aria-label="Scan status: Idle"></span>')}<span class="sr-only">Configured libraries loaded</span>`)}${link('Filler', 'list-video', '/filler')}${link('Playback', 'tv-minimal-play', '/playback')}${link('Settings', 'settings', '/settings')}${link('Logs', 'file-text', '/logs')}</nav><footer class="current-sidebar-footer"><a href="./assets/help/welcome.html" data-app-path="/help/">${actionIcon('book-open')}<span>User Guide</span></a><div class="current-sidebar-account"><a href="./docs/audit.md" data-app-path="/account"><span><small>Signed in via local</small><strong>Alex Morgan</strong></span>${actionIcon('chevron-right')}</a><button type="button" class="icon" aria-label="Sign out">${actionIcon('log-out')}</button></div></footer></aside>`;
}

/** Keep mobile navigation separate from contextual help, with native modal focus containment. */
export function bindShell() {
	const dialog = document.createElement('dialog');
	dialog.className = 'navigation-drawer';
	dialog.setAttribute('aria-label', 'Navigation');
	dialog.innerHTML = `<button type="button" class="icon navigation-close" aria-label="Close navigation">${icon('x')}</button>${sidebar(new URL(document.location.href).searchParams.get('layout') ?? 'catalog', 'drawer')}`;
	document.body.append(dialog);
	let opener;
	document.addEventListener('click', event => {
		const toggle = event.target.closest('[data-nav-toggle]');
		if (toggle) {
			const open = toggle.getAttribute('aria-expanded') !== 'true';
			toggle.setAttribute('aria-expanded', String(open));
			document.getElementById(toggle.getAttribute('aria-controls')).hidden = !open;
		}
		const trigger = event.target.closest('[data-navigation]');
		if (trigger) {
			opener = trigger;
			trigger.setAttribute('aria-expanded', 'true');
			dialog.showModal();
		}
	});
	dialog.querySelector('[aria-label="Close navigation"]').onclick = () => dialog.close();
	dialog.onclick = event => {
		if (event.target === dialog) {
			dialog.close();
		}
	};
	dialog.addEventListener('close', () => {
		opener?.setAttribute('aria-expanded', 'false');
		opener?.focus();
	});
}
