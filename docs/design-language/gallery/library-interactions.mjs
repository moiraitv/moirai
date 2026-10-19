import { filterReference } from './filter-reference.mjs';
/* global document, window */
import { icon } from './fixtures.mjs';

/** Exercise the existing library menu and history affordances with local fixture content. */
export function bindLibrary() {
	const trigger = document.querySelector('[data-library-sort]');
	if (!trigger || !document.querySelector('#library-sort-menu')) {
		return;
	}
	const menu = document.querySelector('#library-sort-menu');
	let order = 'Title';
	let reverse = false;
	trigger.onclick = () => {
		const bounds = trigger.getBoundingClientRect();
		menu.showPopover();
		menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 8))}px`;
		menu.style.top = `${bounds.bottom + 8}px`;
		menu.querySelector('button').focus();
	};
	menu.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
	menu.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			menu.hidePopover();
			trigger.focus();
		}
	});
	menu.querySelectorAll('button').forEach(button => button.onclick = () => {
		if (button.hasAttribute('data-library-reverse')) {
			reverse = !reverse;
		}
		else {
			order = button.dataset.libraryOrder;
		}
		const direction = order === 'Date Added' ? (reverse ? 'Newest' : 'Oldest') : (reverse ? 'Z–A' : 'A–Z');
		trigger.querySelector('span').textContent = `Sort by: ${order} ${direction}`;
		menu.hidePopover();
		trigger.focus();
	});
	document.querySelectorAll('[data-library-letter]:not(:disabled)').forEach(button => button.onclick = () => {
		document.querySelectorAll('[data-library-letter]').forEach(letter => letter.removeAttribute('aria-current'));
		button.setAttribute('aria-current', 'location');
		const card = [...document.querySelectorAll('.media-card')].find(item => item.querySelector('h4').textContent.startsWith(button.dataset.libraryLetter));
		card?.scrollIntoView({ block: 'center', behavior: 'instant' });
	});

	const filters = document.createElement('dialog');
	filters.className = 'filter-dialog';
	filters.setAttribute('aria-label', 'Filter media');
	filters.innerHTML = filterReference();
	document.body.append(filters);
	document.querySelector('[data-library-filter]').onclick = () => filters.showModal();
	filters.addEventListener('change', () => {
		const all = filters.querySelector('input[value="all"]').checked;
		filters.querySelectorAll('[data-genre-exclude]').forEach(button => {
			button.disabled = !all;
			if (!all) {
				button.setAttribute('aria-pressed', 'false');
			}
		});
	});
	filters.querySelectorAll('[data-genre-rule]').forEach(button => button.onclick = () => {
		const selected = button.getAttribute('aria-pressed') !== 'true';
		button.closest('[role="group"]').querySelectorAll('button').forEach(peer => peer.setAttribute('aria-pressed', String(peer === button && selected)));
	});
	filters.addEventListener('reset', () => {
		filters.querySelectorAll('[data-genre-rule]').forEach(button => button.setAttribute('aria-pressed', 'false'));
		filters.querySelectorAll('[data-genre-exclude]').forEach(button => {
			button.disabled = true; 
		});
	});
	filters.addEventListener('close', () => {
		if (filters.returnValue !== 'apply') {
			filters.querySelector('form').reset();
		}
	});

	const history = document.createElement('dialog');
	history.className = 'confirm scan-history-reference';
	history.setAttribute('aria-label', 'Scan history');
	history.innerHTML = `<div class="stack confirm-body"><header class="row between"><h2>Scan history</h2><button type="button" class="icon" aria-label="Close scan history">${icon('x')}</button></header><article class="stack tight"><span class="pill success">Completed</span><span>Today, 18:00</span><span class="secondary">8 found · 0 changed · 0 removed</span></article></div>`;
	document.body.append(history);
	history.querySelector('button').onclick = () => history.close();
	history.onclick = event => {
		if (event.target === history) {
			history.close();
		}
	};
	document.querySelector('[data-scan-history]').onclick = () => history.showModal();
}
