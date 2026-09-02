/** Callback that disarms the one active draft-local destructive action. */
let activeDisarm: (() => void) | undefined;

/** Claim the shared armed state, disarming any previously active delete control. */
export function claimInlineDelete(disarm: () => void): void {
	activeDisarm?.();
	activeDisarm = disarm;
}

/** Release the shared armed state without disturbing a newer delete control. */
export function releaseInlineDelete(disarm: () => void): void {
	if (activeDisarm === disarm) {
		activeDisarm = undefined;
	}
}
