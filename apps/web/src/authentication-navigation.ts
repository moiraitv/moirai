/** Authentication-relevant fields selected from one Vue Router navigation target. */
export interface AuthenticationNavigationTarget {
	fullPath: string;
	meta: {
		publicAuthentication?: unknown;
		allowAuthenticated?: unknown;
	};
}

/** Redirect returned by the authentication boundary, or null when navigation may continue. */
export type AuthenticationNavigationRedirect
	= | string
		| { path: string; query: { returnTo: string } }
		| null;

/** Select the redirect required for current session state and authentication-route metadata. */
export function authenticationNavigationRedirect(
	authenticated: boolean,
	initialized: boolean,
	target: AuthenticationNavigationTarget,
): AuthenticationNavigationRedirect {
	const publicAuthentication = target.meta.publicAuthentication === true;
	const allowAuthenticated = target.meta.allowAuthenticated === true;
	if (authenticated && publicAuthentication && !allowAuthenticated) {
		return '/';
	}
	if (!authenticated && !publicAuthentication) {
		const path = initialized ? '/login' : '/setup';
		return { path, query: { returnTo: target.fullPath } };
	}

	return null;
}
