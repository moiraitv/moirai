/** Read the bounded Unicode family name from an OpenType naming table. */
export function graphicsFontFamily(bytes: Buffer): string {
	if (bytes.length < 12 || bytes.length > 4 * 1024 * 1024 || !['00010000', '4f54544f'].includes(bytes.subarray(0, 4).toString('hex'))) {
		throw new Error('Invalid or oversized OpenType font');
	}
	const count = bytes.readUInt16BE(4);
	for (let index = 0; index < count && 12 + (index + 1) * 16 <= bytes.length; index++) {
		const record = 12 + index * 16;
		if (bytes.toString('ascii', record, record + 4) !== 'name') {
			continue;
		}
		const start = bytes.readUInt32BE(record + 8);
		const length = bytes.readUInt32BE(record + 12);
		if (length < 6 || start + length > bytes.length) {
			break;
		}
		const strings = bytes.readUInt16BE(start + 4);
		const records = bytes.readUInt16BE(start + 2);
		const names: string[] = [];
		for (let entry = 0; entry < records && 6 + (entry + 1) * 12 <= length; entry++) {
			const offset = start + 6 + entry * 12;
			const platform = bytes.readUInt16BE(offset);
			const id = bytes.readUInt16BE(offset + 6);
			const size = bytes.readUInt16BE(offset + 8);
			const relative = strings + bytes.readUInt16BE(offset + 10);
			if ((platform === 0 || platform === 3) && (id === 1 || id === 16) && size > 0 && size <= 240 && size % 2 === 0
				&& relative + size <= length) {
				const value = Buffer.from(bytes.subarray(start + relative, start + relative + size)).swap16().toString('utf16le').trim();
				if (value && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)) {
					names[id] ??= value;
				}
			}
		}
		const family = names[16] ?? names[1];
		if (family) {
			return family;
		}
		break;
	}
	throw new Error('Font has no supported family name');
}
