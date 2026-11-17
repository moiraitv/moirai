/** Explain credential exposure for HTTP and unverified TLS connections beside editable fields. */
export function mediaServerTransportWarning(address: string, allowInsecureTls: boolean): string {
	try {
		const url = new URL(address.trim());
		const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
		const loopback = host === 'localhost' || host === '::1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
		if (url.protocol === 'http:' && !loopback) {
			return 'This connection uses HTTP. Anyone who can intercept its traffic can read the token or API key and any password used to sign in. Use HTTPS when possible.';
		}
		if (url.protocol === 'https:' && allowInsecureTls) {
			return 'This connection accepts an untrusted certificate. An impersonated server can receive the token or API key and any password used to sign in. Use a trusted certificate when possible.';
		}
	}
	catch {
		// Address validation reports incomplete or invalid input separately.
	}

	return '';
}
