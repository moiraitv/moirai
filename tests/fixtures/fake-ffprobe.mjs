#!/usr/bin/env node

import { readFileSync } from 'node:fs';

if (process.argv.includes('-version')) {
	console.log('ffprobe version moirai-test');
	process.exit(0);
}

if (process.argv.includes('-protocols')) {
	console.log('Supported file protocols:\nInput:\n  fd\n  file\nOutput:\n  fd\n  file');
	process.exit(0);
}

const descriptorOption = process.argv.indexOf('-fd');
if (
	descriptorOption < 0
	|| process.argv[descriptorOption + 1] !== '4'
	|| process.argv.at(-1) !== 'fd:'
	|| readFileSync(4).length === 0
) {
	process.exit(2);
}

console.log(JSON.stringify({
	format: { duration: '5880.125', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
	streams: [
		{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
		{ codec_type: 'audio', codec_name: 'aac' },
	],
}));
