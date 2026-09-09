import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** Build once, never review-gating draft documentation, and clear disposable captures. */
export default async function setup(): Promise<void> {
	execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
	const stage = path.resolve('test-results/docs-screenshots');
	await rm(stage, { recursive: true, force: true });
	await mkdir(stage, { recursive: true });
}
