/** Recovery code capture plus whether browser history may safely discard its source fragment. */
export interface RecoveryFragmentCapture {
	token: string;
	clearFragment: boolean;
}

/** Capture a recovery code while retaining its fragment until authentication bootstrap succeeds. */
export function captureRecoveryFragment(
	hash: string,
	authenticationLoaded: boolean,
): RecoveryFragmentCapture {
	const token = hash.startsWith('#')
		? new URLSearchParams(hash.slice(1)).get('token') ?? ''
		: '';
	return { token, clearFragment: token.length > 0 && authenticationLoaded };
}
