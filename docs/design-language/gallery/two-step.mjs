/* global document, window */

/** Only one inline confirmation owns the armed state across the gallery. */
let activeDisarm;

/** Lucide Check path, matching the application's TwoStepActionButton. */
export function confirmationMark() {
	return '<svg class="confirmation-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>';
}

/** Keep the initial content in layout while centering the armed presentation over it. */
export function armedContent(initial, confirmText = '') {
	return `<span class="two-step-original" aria-hidden="true">${initial}</span><span class="two-step-confirmation" aria-hidden="true">${confirmationMark()}${confirmText ? `<span>${confirmText}</span>` : ''}</span>`;
}

/** Bind the existing checkmark-style confirmation pattern to a local prototype action. */
export function bindTwoStep(button, onConfirm) {
	const initial = button.innerHTML;
	const label = button.getAttribute('aria-label') ?? button.textContent.trim();
	const confirmLabel = button.dataset.confirmLabel ?? `Confirm ${label.toLowerCase()}`;
	const confirmText = button.dataset.confirmText ?? '';
	let armed = false;
	let timer;
	button.setAttribute('aria-pressed', 'false');

	const disarm = () => {
		armed = false;
		button.innerHTML = initial;
		button.classList.remove('armed');
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-pressed', 'false');
		window.clearTimeout(timer);
		document.removeEventListener('pointerdown', outside);
		if (activeDisarm === disarm) {
			activeDisarm = undefined;
		}
	};
	const outside = event => {
		if (!button.contains(event.target)) {
			disarm();
		}
	};
	button.addEventListener('click', () => {
		if (armed) {
			disarm();
			onConfirm();
			return;
		}
		activeDisarm?.();
		activeDisarm = disarm;
		armed = true;
		button.classList.add('armed');
		button.innerHTML = armedContent(initial, confirmText);
		if (confirmText) {
			const style = window.getComputedStyle(button);
			const available = button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			const confirmation = button.querySelector('.two-step-confirmation');
			if (confirmation.getBoundingClientRect().width > available) {
				confirmation.querySelector('span')?.remove();
			}
		}
		button.setAttribute('aria-label', confirmLabel);
		button.setAttribute('aria-pressed', 'true');
		document.addEventListener('pointerdown', outside);
		timer = window.setTimeout(disarm, 5000);
	});
	button.addEventListener('blur', disarm);
	button.addEventListener('keydown', event => {
		if (event.key === 'Escape' && armed) {
			event.preventDefault();
			event.stopPropagation();
			disarm();
		}
	});
	return disarm;
}
