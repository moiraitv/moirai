/* global document */
import { icon } from './fixtures.mjs';
import { guideDetail } from './domain-layouts.mjs';

/** Exercise local log filtering/details and copy confirmation without contacting IPTV services. */
export function bindDomain(notify) {
	document.querySelectorAll('[data-guide-slot]').forEach(button => button.onclick = () => {
		const dialog = document.createElement('dialog');
		dialog.className = 'confirm guide-detail-reference';
		dialog.setAttribute('aria-label', 'Schedule item details');
		dialog.innerHTML = guideDetail(Number(button.dataset.guideMedia));
		document.body.append(dialog);
		dialog.querySelector('[data-guide-close]').onclick = () => dialog.close();
		dialog.addEventListener('close', () => {
			dialog.remove();
			button.focus();
		});
		dialog.onclick = event => {
			if (event.target === dialog) {
				dialog.close();
			}
		};
		dialog.showModal();
	});

	document.querySelectorAll('[data-copy-feed]').forEach(button => button.onclick = async () => {
		const value = button.dataset.feedUrl;
		const error = button.closest('.guide-feed').querySelector('[data-feed-error]');
		error.hidden = true;
		try {
			await navigator.clipboard.writeText(value);
			notify('URL copied');
		}
		catch {
			error.textContent = `Could not copy URL. Copy it manually: ${value}`;
			error.hidden = false;
		}
	});
	const root = document.querySelector('#logs');
	if (!root) {
		return;
	}
	const update = () => {
		const query = root.querySelector('[data-log-search]').value.toLowerCase();
		const level = root.querySelector('[data-log-level]').value.toLowerCase();
		root.querySelectorAll('[data-log-entry]').forEach(row => {
			row.hidden = !row.textContent.toLowerCase().includes(query) || (level !== 'all levels' && row.dataset.logSeverity !== level);
		});
		root.querySelector('[data-log-empty]').hidden = Boolean(root.querySelector('[data-log-entry]:not([hidden])'));
	};
	root.querySelector('[data-log-search]').oninput = update;
	root.querySelector('[data-log-level]').onchange = update;
	root.querySelector('[data-log-pause]').onclick = event => {
		const button = event.currentTarget;
		const paused = button.dataset.paused !== 'true';
		button.dataset.paused = String(paused);
		button.innerHTML = `${icon(paused ? 'play' : 'pause')}${paused ? 'Resume' : 'Pause'} Live Refresh`;
	};
	const dialog = document.createElement('dialog');
	dialog.className = 'confirm log-detail-reference';
	dialog.setAttribute('aria-label', 'Log entry details');
	document.body.append(dialog);
	root.querySelectorAll('[data-log-entry]').forEach(row => row.onclick = () => {
		dialog.innerHTML = `<div class="stack confirm-body"><header class="row between"><h2>Log entry details</h2><button type="button" class="icon" aria-label="Close log entry details">${icon('x')}</button></header><pre>${row.textContent.trim()}</pre></div>`;
		dialog.querySelector('button').onclick = () => dialog.close();
		dialog.showModal();
	});
}
