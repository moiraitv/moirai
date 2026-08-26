import { rm } from 'node:fs/promises';
import path from 'node:path';

/** Isolated runtime root cleared before each browser-test server starts. */
const runtimeRoot = path.resolve('test-results/runtime');

// Browser tests author persistent resources, so each server run needs an isolated empty catalog.
await Promise.all([
	rm(path.join(runtimeRoot, 'data'), { recursive: true, force: true }),
	rm(path.join(runtimeRoot, 'etv'), { recursive: true, force: true }),
]);
await import('./dev.mjs');
