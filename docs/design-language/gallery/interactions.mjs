import { bindLanguages } from './language.mjs';
import { bindDomain } from './domain-interactions.mjs';
import { bindSequences } from './program-reference.mjs';
import { bindCatalog } from './catalog.mjs';
import { bindPreferences } from './preferences.mjs';
import { bindHelp } from './help.mjs';
import { bindShell } from './shell.mjs';
/* global document, window */
import { editorSurface } from './pages.mjs';
import { menuItems, actionIcon, programs } from './fixtures.mjs';
import { bindLibrary } from './library-interactions.mjs';
import { bindMediaSelection } from './media-selection.mjs';
import { bindSettings } from './settings.mjs';
import { bindTwoStep } from './two-step.mjs';

/** Read all editable draft values in a stable order, including unchecked choices. */
function draftValues(form) {
	return JSON.stringify([...form.querySelectorAll('input, select, textarea')].map(input => ['checkbox', 'radio'].includes(input.type) ? input.checked : input.value));
}

/** One expiry belongs to the currently visible toast, including rapid replacements. */
let toastTimer;

/** Show a dismissible success toast; pause its read time during focus or hover. */
function toast(message) {
	const region = document.querySelector('.toast-region');
	const footer = [...document.querySelectorAll('.editor-footer')].find(element => element.checkVisibility());
	region.style.bottom = footer ? `${window.innerHeight - footer.getBoundingClientRect().top + 12}px` : ''; 
	region.innerHTML = `<div class="toast" role="status"><span class="status-icon">✓</span><span>${message}</span><button class="ghost icon" aria-label="Dismiss notification">×</button></div>`;
	const clear = () => window.clearTimeout(toastTimer);
	const schedule = () => {
		clear();
		toastTimer = window.setTimeout(() => {
			region.replaceChildren(); 
		}, 5000);
	};
	region.querySelector('button').addEventListener('click', () => {
		clear();
		region.replaceChildren();
	});
	region.onmouseenter = clear;
	region.onmouseleave = schedule;
	region.onfocusin = clear;
	region.onfocusout = schedule;
	schedule();
}

/** Ask a concrete, non-persistent prototype confirmation with a safe initial focus. */
function confirmAction(title, message, action, callback) {
	const dialog = document.querySelector('#confirm-dialog');
	dialog.innerHTML = `<div class="confirm-body"><h2 id="confirm-title">${title}</h2><p class="secondary">${message}</p><div class="row"><button data-confirm-cancel autofocus>${action.startsWith('Delete') ? 'Cancel' : 'Keep editing'}</button><button class="danger" data-confirm-accept>${action.startsWith('Delete') ? actionIcon('trash-2') : ''}<span>${action}</span></button></div></div>`;
	dialog.querySelector('[data-confirm-cancel]').onclick = () => dialog.close();
	dialog.querySelector('[data-confirm-accept]').onclick = () => {
		dialog.close();
		callback();
	};
	dialog.showModal();
}

/** Bind dirty tracking and route all editor dismissal through the same guard. */
function bindEditor(form) {
	let baseline = draftValues(form);
	bindPreferences(form);
	const reset = form.querySelector('[data-reset]');
	const save = form.querySelector('[data-save]');
	const error = form.querySelector('[data-editor-error]');
	const inputs = [...form.querySelectorAll('input, textarea, select')];
	let savedInputs = inputs.map(input => ({ value: input.value, checked: input.checked }));
	const dirty = () => draftValues(form) !== baseline;
	const valid = () => form.querySelector('#channel-name').value.trim() !== ''
		&& Number(form.querySelector('#channel-number').value) > 0 && form.checkValidity();
	const disarm = bindTwoStep(reset, () => {
		inputs.forEach((input, index) => {
			if (input.type !== 'file') {
				input.value = savedInputs[index].value;
			}
			input.checked = savedInputs[index].checked;
		});
		form.querySelectorAll('[data-subtitle-reference], [data-encoding-reference]').forEach(section => section.dispatchEvent(new Event('change')));
		update();
	});
	const update = () => {
		reset.disabled = !dirty();
		form.querySelector('[data-channel-schedule]').hidden = dirty();
		form.querySelector('[data-channel-schedule-disabled]').hidden = !dirty();
		form.querySelector('[data-channel-schedule-note]').hidden = !dirty();
		save.disabled = dirty() && !valid();
		const label = dirty() ? 'Save' : 'Close';
		if (save.textContent !== label) {
			save.innerHTML = dirty() ? `${actionIcon('save')}<span>${label}</span>` : label;
		}
		save.type = dirty() ? 'submit' : 'button';
		save.classList.toggle('primary', dirty());
		const identityValid = form.querySelector('#channel-name').value.trim() !== '' && Number(form.querySelector('#channel-number').value) > 0;
		error.hidden = identityValid;
		error.textContent = identityValid ? '' : 'Enter a name and a channel number greater than zero.';
		for (const id of ['channel-name', 'channel-number']) {
			const input = form.querySelector(`#${id}`);
			const invalid = id === 'channel-number' ? !(Number(input.value) > 0) : input.value.trim() === '';
			input.setAttribute('aria-invalid', String(invalid));
			input.setAttribute('aria-describedby', 'editor-error');
		}
	};
	const close = () => {
		disarm();
		const dialog = form.closest('dialog');
		if (dialog) {
			dialog.close();
		}
		else {
			window.location.href = '?layout=catalog';
		}
	};
	const dismiss = () => {
		if (dirty()) {
			confirmAction('Discard unsaved changes?', 'Your channel draft has changes that have not been saved.', 'Discard changes', close);
		}
		else {
			close();
		}
	};

	form.addEventListener('input', update);
	form.addEventListener('change', update);
	form.querySelector('[data-editor-close]').onclick = dismiss;
	save.addEventListener('click', () => {
		if (!dirty()) {
			close();
		}
	});
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (!dirty() || !valid()) {
			return;
		}
		baseline = draftValues(form);
		savedInputs = inputs.map(input => ({ value: input.value, checked: input.checked }));
		disarm();
		update();
		toast('Channel saved · prototype only');
	});
	form.querySelector('[data-delete]').onclick = () => {
		confirmAction('Delete Channel?', 'Night flight will be permanently removed. Any unsaved draft will be discarded. This prototype does not delete application data.', 'Delete Channel', () => {
			close();
			toast('Channel deleted · prototype only');
		});
	};
	form.addEventListener('keydown', event => {
		if (event.key === 'Escape' && !form.closest('dialog')) {
			event.preventDefault();
			dismiss();
		}
	});
	const dialog = form.closest('dialog');
	if (dialog) {
		dialog.oncancel = event => {
			event.preventDefault();
			dismiss();
		};
		dialog.onclick = event => {
			if (event.target === dialog) {
				dismiss();
			}
		};
	}
	update();
}

/** Wire only the explicitly documented working behaviors in this static gallery. */
export function bindInteractions() {
	bindSettings();
	bindShell();
	bindHelp();
	bindPreferences(document);
	bindMediaSelection(toast);
	bindLibrary();
	bindCatalog();
	bindSequences(toast);
	bindDomain(toast);
	bindLanguages();
	document.body.insertAdjacentHTML('beforeend', '<dialog id="editor-dialog" aria-labelledby="editor-title"></dialog><dialog class="confirm" role="alertdialog" id="confirm-dialog" aria-labelledby="confirm-title"></dialog><div class="toast-region"></div><div id="action-popover" popover class="popover-sample menu-live"></div>');
	document.addEventListener('click', event => {
		const picker = event.target.closest('[data-logo-pick]');
		if (picker) {
			picker.parentElement.querySelector('input[type="file"]').click();
		}
	});
	const editor = document.querySelector('#editor-dialog');
	const popover = document.querySelector('#action-popover');
	const openEditor = () => {
		editor.innerHTML = editorSurface();
		bindEditor(editor.querySelector('form'));
		editor.showModal();
		editor.querySelector('#channel-name').focus();
	};
	document.querySelectorAll('[data-open-editor]').forEach(button => button.addEventListener('click', openEditor));
	document.querySelectorAll('[data-editor-form]').forEach(bindEditor);
	document.querySelectorAll('[data-toast]').forEach(button => button.onclick = () => toast('Program saved · prototype only'));
	document.querySelectorAll('[data-delete]:not(form button)').forEach(button => button.onclick = () => confirmAction('Delete Channel?', 'This is a visual confirmation example. No application data is changed.', 'Delete Channel', () => toast('Channel deleted · prototype only')));
	// Native popovers supply light dismissal; ordinary menu rows retain Tab navigation.
	let menuTrigger;
	popover.innerHTML = menuItems();
	const closeMenu = () => {
		popover.hidePopover();
		menuTrigger?.focus();
	};
	popover.addEventListener('toggle', event => {
		menuTrigger?.setAttribute('aria-expanded', String(event.newState === 'open'));
	});
	popover.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
		}
	});
	popover.querySelectorAll('button[data-context-action]').forEach(button => button.onclick = () => {
		closeMenu();
		if (button.dataset.contextAction === 'Delete Program') {
			confirmAction('Delete program?', 'This example does not delete application data.', 'Delete program', () => toast('Program deleted · prototype only'));
		}
		else {
			toast(`${button.dataset.contextAction} selected · prototype only`);
		}
	});
	document.querySelectorAll('[data-menu]').forEach(button => {
		button.setAttribute('aria-expanded', 'false');
		button.setAttribute('aria-controls', 'action-popover');
		button.onclick = () => {
			menuTrigger = button;
			const identity = button.closest('.current-program-row')?.querySelector('[data-inspect]');
			const edit = popover.querySelector('a');
			const index = Number(identity?.dataset.inspect ?? 1);
			edit.href = programs[index][2] === 'Sequence' ? '?layout=program-editor' : '?family=programs';
			edit.dataset.appPath = `/schedules/programs/fixture-${index}`;
			const rect = button.getBoundingClientRect();
			popover.showPopover();
			const bounds = popover.getBoundingClientRect();
			popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
			popover.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - bounds.height - 8))}px`;
			popover.querySelector('a, button').focus();
		};
	});
	document.querySelectorAll('.tooltip-wrap').forEach(wrapper => {
		wrapper.addEventListener('keydown', event => {
			if (event.key === 'Escape') {
				wrapper.classList.add('tooltip-dismissed');
			}
		});
		wrapper.addEventListener('focusout', () => wrapper.classList.remove('tooltip-dismissed'));
		wrapper.addEventListener('mouseleave', () => wrapper.classList.remove('tooltip-dismissed'));
	});
	document.addEventListener('click', event => {
		const button = event.target.closest('[data-detailed-choice]');
		if (!button) {
			return;
		}
		button.closest('.detailed-choices').querySelectorAll('[data-detailed-choice]').forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
		const seed = button.closest('section')?.querySelector('[data-sequence-seed]');
		if (seed) {
			seed.hidden = !['shuffled-blocks', 'shuffled-allocations'].includes(button.dataset.detailedChoice);
		}
		button.dispatchEvent(new Event('input', { bubbles: true }));
	});

	document.querySelectorAll('[data-segment]').forEach(button => button.onclick = () => {
		button.parentElement.querySelectorAll('button').forEach(sibling => sibling.setAttribute('aria-pressed', String(sibling === button)));
	});

	document.addEventListener('reference-dismiss', event => {
		if (event.detail.dirty) {
			confirmAction('Discard unsaved changes?', 'Your Program draft has changes that have not been saved.', 'Discard changes', event.detail.close);
		}
		else {
			event.detail.close();
		}
	});
	document.addEventListener('click', event => {
		const remove = event.target.closest('[data-program-delete], [data-backup-delete]');
		if (remove) {
			const type = remove.hasAttribute('data-backup-delete') ? 'backup' : 'Program';
			confirmAction(`Delete ${type}?`, `This ${type} will be permanently removed. This reference does not change application data.`, `Delete ${type}`, () => toast(`${type} deleted · prototype only`));
		}
	});
	document.addEventListener('reference-delete', () => confirmAction('Delete Program?', 'This Program will be permanently removed. Unsaved draft changes will be discarded. This reference does not change application data.', 'Delete Program', () => {
		window.location.href = '?layout=catalog'; 
	}));

	// Use the same coordinated checkmark confirmation for reset and draft-local actions.
	document.querySelectorAll('[data-two-step]:not([data-sequence-remove])').forEach(button => {
		button.classList.add(`tone-${button.dataset.tone ?? 'danger'}`);
		bindTwoStep(button, () => toast('Draft action confirmed · prototype only'));
	});
}
