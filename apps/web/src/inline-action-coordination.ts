/** Callback that disarms the one active compact confirmation action. */
let activeDisarm: (() => void) | undefined;

/** Claim the shared armed state, disarming any previously active action. */
export function claimInlineAction(disarm: () => void): void {
	activeDisarm?.();
	activeDisarm = disarm;
}

/** Release the shared armed state without disturbing a newer action. */
export function releaseInlineAction(disarm: () => void): void {
	if (activeDisarm === disarm) {
		activeDisarm = undefined;
	}
}
