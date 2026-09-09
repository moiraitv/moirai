import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('freezes documentation wall time without freezing timers or monotonic deadlines', async () => {
	const { stdout } = await promisify(execFile)(process.execPath, [
		'--import', path.resolve('tests/e2e/documentation/clock.mjs'), '--input-type=module', '-e',
		`const before = Date.now(); const started = performance.now();
		await new Promise(resolve => setTimeout(resolve, 25));
		console.log(JSON.stringify({ before, after: Date.now(), elapsed: performance.now() - started }));`,
	], { timeout: 5000 });
	const result = JSON.parse(stdout);
	expect(result.before).toBe(Date.parse('2026-01-15T10:30:00Z'));
	expect(result.after).toBe(result.before);
	expect(result.elapsed).toBeGreaterThanOrEqual(20);
});
