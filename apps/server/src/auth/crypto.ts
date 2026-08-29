import {
	argon2,
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	timingSafeEqual,
} from 'node:crypto';

/** Argon2id memory cost in KiB selected from current password-storage guidance. */
const ARGON2_MEMORY_KIB = 19_456;
/** Argon2id passes selected from current password-storage guidance. */
const ARGON2_PASSES = 2;
/** Argon2id parallel lanes used for one interactive password operation. */
const ARGON2_PARALLELISM = 1;
/** Derived password-hash length in bytes. */
const ARGON2_TAG_LENGTH = 32;

/** Derive one Argon2id password hash without blocking the event loop. */
function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		argon2('argon2id', {
			message: password,
			nonce: salt,
			parallelism: ARGON2_PARALLELISM,
			tagLength: ARGON2_TAG_LENGTH,
			memory: ARGON2_MEMORY_KIB,
			passes: ARGON2_PASSES,
		}, (error, result) => {
			if (error) {
				reject(error);
			}
			else {
				resolve(result);
			}
		});
	});
}

/** Hash a local administrator password with versioned, self-describing Argon2id parameters. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await derivePassword(password, salt);
	return [
		'argon2id',
		'v=1',
		`m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`,
		salt.toString('base64url'),
		hash.toString('base64url'),
	].join('$');
}

/** Verify a password against the supported versioned Argon2id storage format. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const [algorithm, version, parameters, saltValue, expectedValue] = encoded.split('$');
	if (
		algorithm !== 'argon2id'
		|| version !== 'v=1'
		|| parameters !== `m=${ARGON2_MEMORY_KIB},t=${ARGON2_PASSES},p=${ARGON2_PARALLELISM}`
		|| !saltValue
		|| !expectedValue
	) {
		return false;
	}

	const expected = Buffer.from(expectedValue, 'base64url');
	if (expected.length !== ARGON2_TAG_LENGTH) {
		return false;
	}

	const actual = await derivePassword(password, Buffer.from(saltValue, 'base64url'));
	return timingSafeEqual(actual, expected);
}

/** Generate an unpredictable browser, CSRF, OIDC, or recovery bearer value. */
export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

/** Reduce a bearer value to the non-reversible lookup key persisted in SQLite. */
export function hashToken(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

/** Encrypt a provider logout hint with a key derived from its configured client secret. */
export function encryptProviderHint(value: string, clientSecret: string): string {
	const key = createHash('sha256').update('moirai:provider-hint\0').update(clientSecret).digest();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

/** Decrypt a provider logout hint or return null after configuration rotation or corruption. */
export function decryptProviderHint(value: string, clientSecret: string): string | null {
	try {
		const [ivValue, tagValue, encryptedValue] = value.split('.');
		if (!ivValue || !tagValue || !encryptedValue) {
			return null;
		}

		const key = createHash('sha256').update('moirai:provider-hint\0').update(clientSecret).digest();
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
		return Buffer.concat([
			decipher.update(Buffer.from(encryptedValue, 'base64url')),
			decipher.final(),
		]).toString('utf8');
	}
	catch {
		return null;
	}
}
