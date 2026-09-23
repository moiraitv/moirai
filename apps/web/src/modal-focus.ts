import { createFocusTrap, type FocusTrap } from 'focus-trap';
import { nextTick, type ObjectDirective } from 'vue';

/** Focus and dismissal options for an existing modal presentation. */
interface ModalFocusOptions {
	active?: boolean;
	navigation?: boolean;
	escape?: () => unknown;
}

/** One shared stack lets nested and teleported dialogs suspend their parent trap. */
const trapStack: FocusTrap[] = [];
/** Backdrops included in modal focus ownership so their dismissal handlers receive clicks. */
const modalBackdropSelector = '.moirai-dialog-backdrop, .selection-drawer-backdrop, .help-drawer-backdrop';
/** Per-element state survives reactive directive updates without reactivating a dialog. */
const states = new WeakMap<HTMLElement, { trap: FocusTrap; options: ModalFocusOptions; keydown: (event: KeyboardEvent) => void }>();

/** Activate or release focus ownership when the presentation's visibility changes. */
function update(element: HTMLElement, options: ModalFocusOptions): void {
	const state = states.get(element)!;
	state.options = options;
	if (options.active !== false && !state.trap.active) {
		if (options.navigation) {
			state.trap.updateContainerElements([element, ...document.querySelectorAll<HTMLElement>('.sidebar-backdrop')]);
		}
		else {
			// Responsive presentations may have gained a backdrop since the directive mounted.
			state.trap.updateContainerElements(element.closest<HTMLElement>(modalBackdropSelector) ?? element);
		}
		state.trap.activate();
	}
	else if (options.active === false && state.trap.active) {
		state.trap.deactivate();
	}
}

/** Focus a surviving opener or a meaningful destination after removing a modal. */
async function restoreFocus(opener: Element | null): Promise<void> {
	await nextTick();
	if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]') && opener.getClientRects().length) {
		opener.focus({ preventScroll: true });
		return;
	}
	if (trapStack.length) {
		return;
	}
	const heading = document.querySelector<HTMLElement>('main h1, main h2');
	if (heading) {
		heading.setAttribute('tabindex', '-1');
		heading.focus({ preventScroll: true });
	}
}

/** Bind focus containment to existing markup, preserving its own draft and transition lifecycle. */
export const modalFocus: ObjectDirective<HTMLElement, ModalFocusOptions | undefined> = {
	mounted(element, binding) {
		element.setAttribute('tabindex', element.getAttribute('tabindex') ?? '-1');
		const container = element.closest<HTMLElement>(modalBackdropSelector) ?? element;
		let opener: Element | null = null;
		const trap = createFocusTrap(container, {
			trapStack,
			initialFocus: () => binding.value?.navigation ? element.querySelector<HTMLElement>('.sidebar-close') ?? element : element,
			fallbackFocus: element,
			delayInitialFocus: false,
			preventScroll: true,
			escapeDeactivates: false,
			clickOutsideDeactivates: false,
			isolateSubtrees: true,
			returnFocusOnDeactivate: false,
			onActivate: () => {
				opener = document.activeElement; 
			},
			onDeactivate: () => {
				void restoreFocus(opener); 
			},
		});
		const keydown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape' || trapStack.at(-1) !== trap) {
				return;
			}
			event.stopPropagation();
			if (!event.defaultPrevented) {
				event.preventDefault();
				states.get(element)?.options.escape?.();
			}
		};
		states.set(element, { trap, options: {}, keydown });
		element.addEventListener('keydown', keydown);
		update(element, binding.value ?? {});
	},
	updated(element, binding) {
		update(element, binding.value ?? {});
	},
	beforeUnmount(element) {
		const state = states.get(element);
		state?.trap.deactivate();
		if (state) {
			element.removeEventListener('keydown', state.keydown);
		}
		states.delete(element);
	},
};
