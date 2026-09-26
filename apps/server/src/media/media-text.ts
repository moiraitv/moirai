import { analyse } from 'chardet';

/** Maximum source bytes normalized for one text subtitle snapshot. */
export const MAX_SUBTITLE_TEXT_BYTES = 16 * 1024 * 1024;
/** Minimum detector confidence accepted for undeclared legacy text. */
const MIN_ENCODING_CONFIDENCE = 80;
/** Required confidence lead over a candidate that produces different text. */
const MIN_ENCODING_LEAD = 20;

/** Explain why media text cannot be decoded safely without guessing its contents. */
export class MediaTextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MediaTextError';
	}
}

/** Decode a supported encoding strictly, retaining legitimate replacement characters in the source. */
function decode(bytes: Uint8Array, encoding: string): string {
	try {
		const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
		if (text.includes('\0')) {
			throw new Error('Unexpected NUL in text');
		}
		return text;
	}
	catch {
		throw new MediaTextError('Unsupported or invalid text encoding; convert the file to UTF-8');
	}
}

/** Canonicalize encoding aliases using the same decoder that will consume the bytes. */
function encodingKey(encoding: string): string {
	try {
		return new TextDecoder(encoding).encoding;
	}
	catch {
		throw new MediaTextError('Unsupported text encoding declaration; convert the file to UTF-8');
	}
}

/** Read an XML declaration only at the start of its decoded prolog. */
function xmlEncoding(text: string): string | null {
	return /^\s*<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/iu.exec(text)?.[1] ?? null;
}

/** Detect confident legacy text, rejecting competing interpretations rather than silently corrupting it. */
function detectLegacyText(bytes: Buffer): string {
	const candidates = new Map<string, number>();
	for (const candidate of analyse(bytes)) {
		try {
			const text = decode(bytes, candidate.name);
			candidates.set(text, Math.max(candidate.confidence, candidates.get(text) ?? 0));
		}
		catch {
			// Unsupported encodings and malformed byte sequences cannot be selected.
		}
	}
	const ranked = [...candidates].sort((left, right) => right[1] - left[1]);
	const best = ranked[0];
	if (!best || best[1] < MIN_ENCODING_CONFIDENCE
		|| (ranked[1] && best[1] - ranked[1][1] < MIN_ENCODING_LEAD)) {
		throw new MediaTextError('Text encoding is uncertain; convert the file to UTF-8');
	}
	return best[0];
}

/** Honor Unicode markers and XML declarations before strict UTF-8 or bounded legacy detection. */
export function decodeMediaText(bytes: Buffer, xml = false): string {
	if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))
		|| bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))) {
		throw new MediaTextError('UTF-32 text is unsupported; convert the file to UTF-8');
	}
	const unicode = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'utf-8'
		: bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? 'utf-16le'
			: bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])) ? 'utf-16be'
				: xml && bytes.subarray(0, 4).equals(Buffer.from([0x3c, 0, 0x3f, 0])) ? 'utf-16le'
					: xml && bytes.subarray(0, 4).equals(Buffer.from([0, 0x3c, 0, 0x3f])) ? 'utf-16be' : null;
	if (unicode) {
		const text = decode(bytes, unicode);
		const declared = xml ? xmlEncoding(text) : null;
		if (declared && !(declared.toLowerCase() === 'utf-16' && unicode.startsWith('utf-16'))
			&& encodingKey(declared) !== unicode) {
			throw new MediaTextError('XML encoding declaration conflicts with its Unicode marker');
		}
		return text;
	}

	const declared = xml ? xmlEncoding(bytes.subarray(0, 1024).toString('latin1')) : null;
	if (declared) {
		// XML labels retain their standards meaning instead of WHATWG's Windows-1252 aliases.
		const label = declared.toLowerCase();
		if (['ascii', 'us-ascii'].includes(label) && bytes.some(value => value > 0x7f)) {
			throw new MediaTextError('Invalid ASCII text; convert the file to UTF-8');
		}
		if (['iso-8859-1', 'iso_8859-1', 'latin1', 'latin-1'].includes(label)) {
			const text = bytes.toString('latin1');
			if (text.includes('\0')) {
				throw new MediaTextError('Invalid XML text encoding; convert the file to UTF-8');
			}
			return text;
		}
		return decode(bytes, declared);
	}
	try {
		return decode(bytes, 'utf-8');
	}
	catch {
		return detectLegacyText(bytes);
	}
}
