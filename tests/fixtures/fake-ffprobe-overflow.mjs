#!/usr/bin/env node
import { appendFileSync, fstatSync, readSync } from 'node:fs';

if (process.argv.includes('-version')) {
	console.log('ffprobe version moirai-test');
	process.exit(0);
}
if (process.argv.includes('-protocols')) {
	console.log('Input:\n  fd\nOutput:\n  fd');
	process.exit(0);
}

const buffer = Buffer.alloc(fstatSync(4).size);
readSync(4, buffer, 0, buffer.length, 0);
const { scenario, log } = JSON.parse(buffer.toString());
const chapters = process.argv.some(arg => arg.includes(':chapter='));
appendFileSync(log, `${chapters ? 'chapters' : 'metadata'}\n`);
if (scenario === 'abort') {
	process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
	setInterval(() => undefined, 1_000);
}
console.log(JSON.stringify({
	format: { duration: '120', format_name: 'matroska' },
	streams: [{ codec_type: 'video', duration: '120', codec_name: 'h264' }],
	...(chapters ? { chapters: [{ start_time: '0', end_time: '120', tags: { title: 'x'.repeat(300_000) } }] } : {}),
	...(scenario === 'metadata' ? { padding: 'x'.repeat(300_000) } : {}),
}));
