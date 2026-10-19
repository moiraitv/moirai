/* global document */
import { actionIcon } from './fixtures.mjs';

/** Demonstrate card modes and destination choice without changing application data. */
export function bindMediaSelection(notify) {
	const dialog = document.createElement('dialog');
	dialog.className = 'confirm';
	dialog.setAttribute('aria-label', 'Add to Program');
	dialog.innerHTML = `<form method="dialog" class="confirm-body stack"><h2>Add to Program</h2><p data-destination-summary></p><label>Program<span class="select-control"><select><option>Evening cinema</option><option>Weekend discoveries</option></select></span></label><p class="small muted">Reference demonstration only. Application data is unchanged.</p><div class="row"><button value="cancel">Cancel</button><button value="add" class="primary">${actionIcon('plus')}<span>Add to Program</span></button></div></form>`;
	document.body.append(dialog);
	dialog.addEventListener('close', () => {
		if (dialog.returnValue === 'add') {
			notify('Added to Program · prototype only');
		}
	});
	const chooseDestination = summary => {
		dialog.querySelector('[data-destination-summary]').textContent = summary;
		dialog.returnValue = '';
		dialog.showModal();
	};

	document.querySelectorAll('[data-media-collection]').forEach(collection => {
		const toggle = collection.querySelector('[data-media-mode]');
		const bulkBar = collection.querySelector('[data-media-bulk]');
		const cards = [...collection.querySelectorAll('.media-card')];
		const add = collection.querySelector('[data-media-add-selected]');
		const update = () => {
			const selected = cards.filter(card => card.querySelector('.media-select').getAttribute('aria-pressed') === 'true');
			const count = collection.querySelector('[data-media-count]');
			count.textContent = count.hasAttribute('data-count-compact') ? `${selected.length} selected` : `${selected.length} ${selected.length === 1 ? 'item' : 'items'} selected`;
			const page = collection.querySelector('[data-media-select-page]');
			if (page) {
				page.textContent = selected.length === cards.length ? 'Clear Page' : 'Select Page';
			}
			add.disabled = selected.length === 0;
		};
		toggle.onclick = () => {
			const bulk = toggle.getAttribute('aria-pressed') !== 'true';
			toggle.setAttribute('aria-pressed', String(bulk));
			const label = bulk ? 'Cancel selection' : 'Select items';
			toggle.setAttribute('aria-label', label);
			toggle.title = label;
			toggle.innerHTML = `${actionIcon(bulk ? 'x' : 'list-plus')}${toggle.hasAttribute('data-media-mode-icon') ? '' : `<span>${label}</span>`}`;
			bulkBar.hidden = !bulk;
			cards.forEach(card => {
				card.querySelector('.media-add').hidden = bulk;
				const primary = card.querySelector('.media-primary');
				primary.tabIndex = bulk ? -1 : 0;
				primary.setAttribute('aria-hidden', String(bulk));
				const select = card.querySelector('.media-select');
				select.hidden = !bulk;
				select.setAttribute('aria-pressed', 'false');
				select.setAttribute('aria-label', `Select ${select.dataset.mediaTitle}`);
				card.classList.remove('selected');
			});
			update();
		};
		cards.forEach(card => {
			const select = card.querySelector('.media-select');
			select.onclick = () => {
				const selected = select.getAttribute('aria-pressed') !== 'true';
				select.setAttribute('aria-pressed', String(selected));
				select.setAttribute('aria-label', `${selected ? 'Deselect' : 'Select'} ${select.dataset.mediaTitle}`);
				card.classList.toggle('selected', selected);
				update();
			};
			card.querySelector('.media-add').onclick = () => chooseDestination(select.dataset.mediaTitle);
		});
		add.onclick = () => chooseDestination(collection.querySelector('[data-media-count]').textContent);
		const addAll = collection.querySelector('[data-media-add-all]');
		if (addAll) {
			addAll.onclick = () => chooseDestination(`${cards.length} matching items`);
		}
		const selectPage = collection.querySelector('[data-media-select-page]');
		if (selectPage) {
			selectPage.onclick = () => {
				const selected = cards.some(card => card.querySelector('.media-select').getAttribute('aria-pressed') !== 'true');
				cards.forEach(card => {
					const select = card.querySelector('.media-select');
					select.setAttribute('aria-pressed', String(selected));
					select.setAttribute('aria-label', `${selected ? 'Deselect' : 'Select'} ${select.dataset.mediaTitle}`);
					card.classList.toggle('selected', selected);
				});
				update();
			};
		}
		update();
	});
}
