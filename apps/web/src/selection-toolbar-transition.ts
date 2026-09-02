import { nextTick, ref, type Ref } from 'vue';

/** Minimal transition event consumed when toolbar dismissal finishes. */
export interface SelectionToolbarTransitionEvent {
	target: EventTarget | null;
	currentTarget: EventTarget | null;
	propertyName: string;
}

/** Reactive state and lifecycle actions for layout-settled toolbar motion. */
export interface SelectionToolbarTransition {
	active: Ref<boolean>;
	mounted: Ref<boolean>;
	revealed: Ref<boolean>;
	show: () => void;
	hide: () => void;
	finish: (event: SelectionToolbarTransitionEvent) => void;
	reset: () => void;
	dispose: () => void;
}

/** Coordinate layout insertion separately from a toolbar's compositor-only motion. */
export function useSelectionToolbarTransition(): SelectionToolbarTransition {
	const active = ref(false);
	const mounted = ref(false);
	const revealed = ref(false);
	let revealFrame: number | undefined;

	/** Cancel a pending reveal frame before dismissal, reset, or disposal. */
	function cancelReveal(): void {
		if (revealFrame !== undefined) {
			cancelAnimationFrame(revealFrame);
			revealFrame = undefined;
		}
	}

	/** Reveal the toolbar after its layout and dependent content have settled. */
	function scheduleReveal(): void {
		cancelReveal();
		revealFrame = requestAnimationFrame(() => {
			revealFrame = requestAnimationFrame(() => {
				revealFrame = undefined;
				if (active.value) {
					revealed.value = true;
				}
			});
		});
	}

	/** Insert the toolbar invisibly before beginning its transition on a later frame. */
	function show(): void {
		mounted.value = true;
		active.value = true;
		void nextTick(scheduleReveal);
	}

	/** Dismiss the toolbar visually before allowing it to leave document layout. */
	function hide(): void {
		const wasRevealed = revealed.value;
		cancelReveal();
		active.value = false;
		revealed.value = false;
		if (!wasRevealed) {
			mounted.value = false;
		}
	}

	/** Remove the hidden toolbar after its opacity transition completes. */
	function finish(event: SelectionToolbarTransitionEvent): void {
		if (
			event.target === event.currentTarget
			&& event.propertyName === 'opacity'
			&& !active.value
		) {
			mounted.value = false;
		}
	}

	/** Immediately clear all toolbar state when its owning page changes identity. */
	function reset(): void {
		cancelReveal();
		active.value = false;
		mounted.value = false;
		revealed.value = false;
	}

	return { active, mounted, revealed, show, hide, finish, reset, dispose: cancelReveal };
}
