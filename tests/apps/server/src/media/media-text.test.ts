import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeMediaText, MediaTextError } from '@server/media/media-text.js';

describe('media text decoding', () => {
	it('preserves strict UTF-8 and Unicode BOM text', () => {
		const text = 'Café 日本語';
		expect(decodeMediaText(Buffer.from(text))).toBe(text);
		expect(decodeMediaText(Buffer.from(`\ufeff${text}`))).toBe(text);
		const little = Buffer.from(text, 'utf16le');
		expect(decodeMediaText(Buffer.concat([Buffer.from([0xff, 0xfe]), little]))).toBe(text);
		expect(decodeMediaText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(little).swap16()]))).toBe(text);
	});

	it('honors declared XML encodings and rejects conflicts or unsupported declarations', () => {
		const text = '<?xml version="1.0" encoding="ISO-8859-1"?><movie><title>Café</title></movie>';
		expect(decodeMediaText(Buffer.from(text, 'latin1'), true)).toBe(text);
		expect(() => decodeMediaText(Buffer.from(`\ufeff${text}`), true)).toThrow(MediaTextError);
		expect(() => decodeMediaText(Buffer.from('<?xml encoding="made-up"?><movie/>'), true)).toThrow(MediaTextError);
		expect(() => decodeMediaText(Buffer.from('<?xml encoding="UTF-8"?><movie>Caf\xe9</movie>', 'latin1'), true)).toThrow(MediaTextError);
	});

	it.each(['western', 'japanese', 'gb18030', 'big5'])('detects substantial %s legacy text without losing characters', async name => {
		const raw = await readFile(`tests/fixtures/media-text/${name}.srt`);
		const expected = await readFile(`tests/fixtures/media-text/${name}.utf8.txt`, 'utf8');
		expect(decodeMediaText(raw)).toBe(expected);
	});

	it('rejects ambiguous short input and low-confidence Cyrillic instead of corrupting it', async () => {
		expect(() => decodeMediaText(Buffer.from('Caf\xe9', 'latin1'))).toThrow(/uncertain/);
		const raw = await readFile('tests/fixtures/media-text/cyrillic.srt');
		expect(() => decodeMediaText(raw)).toThrow(/uncertain/);
	});

	it('rejects malformed Unicode markers without falling back to a legacy guess', () => {
		expect(() => decodeMediaText(Buffer.from([0xef, 0xbb, 0xbf, 0xff]))).toThrow(MediaTextError);
		expect(() => decodeMediaText(Buffer.from([0xff, 0xfe, 0x61]))).toThrow(MediaTextError);
		expect(() => decodeMediaText(Buffer.from([0xff, 0xfe, 0, 0, 0x61, 0, 0, 0]))).toThrow(/UTF-32/);
	});
});


it('does not apply browser Windows-1252 aliases to explicit XML Latin-1 or ASCII', () => {
	const latin = Buffer.from('<?xml encoding="ISO-8859-1"?><movie>\x80</movie>', 'latin1');
	expect(decodeMediaText(latin, true)).toContain('\u0080');
	expect(() => decodeMediaText(Buffer.from('<?xml encoding="US-ASCII"?><movie>Caf\xe9</movie>', 'latin1'), true)).toThrow(/ASCII/);
});
