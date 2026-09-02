import { ref, type Ref } from 'vue';

/** State and callbacks that preserve a surface until its exit transition completes. */
export interface AnimatedDismissal {
	visible: Ref<boolean>;
	requestClose: () => void;
	finishClose: () => void;
}

/** Delay a surface's owning close callback until Vue reports that its leave transition finished. */
export function useAnimatedDismissal(onClosed: () => void): AnimatedDismissal {
	const visible = ref(true);

	/** Begin the leave transition once, ignoring repeated dismissal gestures. */
	function requestClose(): void {
		visible.value = false;
	}

	return { visible, requestClose, finishClose: onClosed };
}
