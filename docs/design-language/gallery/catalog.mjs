/* global document, window */
import { inspector } from './fixtures.mjs';

/** Preserve inline desktop inspection and source-owned modal inspection below 1220px. */
export function bindCatalog() {
	document.querySelectorAll('[data-reference-new-program]').forEach(button => {
		button.onclick = () => window.location.assign('?family=programs');
	});

	const workspace = document.querySelector('.workspace');
	/** Keep the list in the source-owned remaining viewport, after its responsive header. */
	const measureWorkspace = () => {
		if (workspace) {
			workspace.style.height = `${Math.max(320, window.innerHeight - workspace.getBoundingClientRect().top - 20)}px`;
		}
	};
	window.addEventListener('resize', measureWorkspace);
	document.fonts.ready.then(measureWorkspace);
	measureWorkspace();

	document.querySelectorAll('.current-program-toolbar').forEach(toolbar => {
		const type = toolbar.querySelector('[aria-label="Filter programs by type"]');
		const definition = toolbar.querySelector('[aria-label="Filter Content definition"]');
		type.onchange = () => {
			definition.closest('.select-control').hidden = !['All types', 'Content'].includes(type.value); 
		};
	});
	document.querySelectorAll('.current-program-list').forEach(list => {
		list.addEventListener('keydown', event => {
			const button = event.target.closest('.current-program-identity');
			if (!button) {
				return;
			}
			const rows = [...list.querySelectorAll('.current-program-identity')].filter(row => !row.closest('article').hidden);
			const index = rows.indexOf(button);
			const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[event.key];
			if (target !== undefined && rows[target]) {
				event.preventDefault();
				rows[target].focus();
			}
		});
	});
	const dialog = document.createElement('dialog');
	dialog.className = 'program-inspector-dialog';
	dialog.setAttribute('aria-label', 'Program details');
	document.body.append(dialog);
	let opener;
	const clearSelection = () => document.querySelectorAll('.current-program-identity').forEach(button => {
		
		button.setAttribute('aria-pressed', 'false');
		button.closest('.current-program-row').classList.remove('selected');
	 
	});
	const select = (index, trigger) => {
		opener = trigger;
		document.querySelectorAll('.current-program-identity').forEach(button => {
			const selected = button.dataset.inspect === String(index);
			button.setAttribute('aria-pressed', String(selected));
			button.closest('.current-program-row').classList.toggle('selected', selected);
		});
		const workspace = document.querySelector('.workspace');
		if (!workspace || window.matchMedia('(max-width: 1220px)').matches) {
			dialog.innerHTML = inspector(index);
			if (!dialog.open) {
				dialog.showModal();
			}
		}
		else {
			workspace.querySelector('.inspector')?.remove();
			workspace.insertAdjacentHTML('beforeend', inspector(index));
			workspace.classList.remove('inspector-closed');
		}
	};
	document.addEventListener('click', event => {
		const trigger = event.target.closest('[data-inspect]');
		if (trigger) {
			select(Number(trigger.dataset.inspect), trigger);
		}
		const close = event.target.closest('[data-inspector-close]');
		if (close) {
			if (dialog.open) {
				dialog.close();
			}
			else {
				close.closest('.workspace')?.classList.add('inspector-closed');
				close.closest('.inspector').remove();
				document.querySelector('.current-program-identity[aria-pressed="true"]')?.focus();
				clearSelection();
			}
		}
	});
	dialog.addEventListener('close', () => {
		clearSelection();
		opener?.focus(); 
	});
	dialog.onclick = event => {
		if (event.target === dialog) {
			dialog.close();
		}
	};
}
