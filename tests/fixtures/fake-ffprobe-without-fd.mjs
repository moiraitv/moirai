#!/usr/bin/env node

if (process.argv.includes('-version')) {
	console.log('ffprobe version moirai-test');
	process.exit(0);
}

if (process.argv.includes('-protocols')) {
	console.log('Supported file protocols:\nInput:\n  file\n  pipe\nOutput:\n  file\n  pipe');
	process.exit(0);
}

process.exit(2);
