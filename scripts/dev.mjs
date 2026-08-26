import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { apiCrashRestartDelay } from './restart-backoff.mjs';

/** Repository root containing both managed development processes. */
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Server workspace watched and built by the coordinator. */
const serverRoot = path.join(repositoryRoot, 'apps/server');
/** Web workspace started after the API becomes ready. */
const webRoot = path.join(repositoryRoot, 'apps/web');
/** Server build script executed before each managed API launch. */
const serverBuild = pathToFileURL(path.join(serverRoot, 'build.mjs')).href;
/** Whether the coordinator should omit Vite for server-focused development. */
const serverOnly = process.argv.includes('--server-only');
/** Source roots whose changes trigger a rebuilt API process. */
const watchRoots = [
	path.join(serverRoot, 'src'),
	path.join(repositoryRoot, 'packages/shared/src'),
	path.join(repositoryRoot, 'packages/ersatztv-contract/src'),
];
/** Grace period before a stuck child receives a forced termination signal. */
const forceKillDelayMs = 2_000;
/** Debounce applied to clustered source-change events. */
const restartDebounceMs = 100;
/** Maximum wait for a rebuilt API to accept connections. */
const apiReadyTimeoutMs = 15_000;
/** Healthy runtime required before crash backoff resets. */
const apiStableWindowMs = 30_000;

let apiChild;
let webChild;
let restartTimer;
let apiCrashRestartTimer;
let apiStableTimer;
let operation = Promise.resolve();
let shuttingDown = false;
let buildNumber = 0;
let apiCrashAttempts = 0;
/** Child processes intentionally stopped by rebuild or shutdown coordination. */
const expectedApiExits = new WeakSet();

/** Start Vite once and reuse it across managed API restarts. */
function ensureWebStarted() {
	if (!serverOnly && !webChild && !shuttingDown) {
		startWeb();
	}
}

/** Reset crash backoff after the API has remained healthy for a meaningful interval. */
function markApiReady(active) {
	clearTimeout(apiStableTimer);
	apiStableTimer = setTimeout(() => {
		if (apiChild === active) {
			apiCrashAttempts = 0;
		}
	}, apiStableWindowMs);
}

/** Queue recovery without allowing a repeatedly crashing API to create a tight process loop. */
function scheduleApiCrashRestart(reason) {
	if (shuttingDown || apiCrashRestartTimer) {
		return;
	}

	const delay = apiCrashRestartDelay(apiCrashAttempts);
	apiCrashAttempts += 1;
	console.error(`[dev] API exited with ${reason}; restarting in ${delay}ms.`);
	apiCrashRestartTimer = setTimeout(() => {
		apiCrashRestartTimer = undefined;
		operation = operation
			.catch((error) => {
				console.error('[dev] Previous development operation failed.', error);
			})
			.then(async () => {
				if (shuttingDown || apiChild) {
					return;
				}

				console.log('[dev] Restarting API after an unexpected exit.');
				const ready = await startApi();
				if (ready) {
					ensureWebStarted();
				}
			});
	}, delay);
}

/** Start api and acquire resources for the dev tool. */
function startApi() {
	const active = spawn(process.execPath, ['dist/main.js'], {
		cwd: serverRoot,
		env: { ...process.env, MOIRAI_DEV_WATCH: '1' },
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
	});
	apiChild = active;
	return new Promise((resolve) => {
		let ready = false;
		const readyTimer = setTimeout(() => {
			console.error('[dev] API did not become ready within 15 seconds; stopping it.');
			signalChild(active, 'SIGKILL');
			resolve(false);
		}, apiReadyTimeoutMs);
		active.on('message', (message) => {
			if (message && typeof message === 'object' && message.type === 'ready') {
				ready = true;
				clearTimeout(readyTimer);
				markApiReady(active);
				resolve(true);
			}
		});
		active.once('exit', (code, signal) => {
			clearTimeout(readyTimer);
			clearTimeout(apiStableTimer);
			if (apiChild === active) {
				apiChild = undefined;
			}
			const expected = expectedApiExits.delete(active);
			if (!shuttingDown && !expected) {
				const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
				scheduleApiCrashRestart(reason);
			}
			if (!ready) {
				resolve(false);
			}
		});
	});
}

/** Stop api and release resources held by the dev tool. */
async function stopApi(force = false) {
	const active = apiChild;
	if (active) {
		expectedApiExits.add(active);
	}

	await stopChild(active, 'API', force);
}

/** Bundle TypeScript before launch so the managed API process has no loader subprocess. */
async function buildApi() {
	buildNumber += 1;
	await import(`${serverBuild}?developmentBuild=${buildNumber}`);
}

/** Start web and acquire resources for the dev tool. */
function startWeb() {
	webChild = spawn(process.execPath, [path.join(repositoryRoot, 'node_modules/vite/bin/vite.js')], {
		cwd: webRoot,
		env: process.env,
		stdio: 'inherit',
	});
	webChild.once('exit', (code, signal) => {
		webChild = undefined;
		if (!shuttingDown) {
			const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
			console.error(`[dev] Web server exited with ${reason}; stopping development services.`);
			void shutdown(code === 0 ? 0 : 1);
		}
	});
}

/** Signal a direct child and bound how long an API restart may wait. */
async function stopChild(active, label, force = false) {
	if (!active || active.exitCode !== null || active.signalCode !== null) {
		return;
	}

	let exited = false;
	const exit = new Promise((resolve) => {
		active.once('exit', () => {
			exited = true;
			resolve();
		});
	});
	signalChild(active, force ? 'SIGKILL' : 'SIGTERM');
	if (force) {
		await exit;
		return;
	}

	let forceTimer;
	await Promise.race([
		exit,
		new Promise((resolve) => {
			forceTimer = setTimeout(resolve, forceKillDelayMs);
		}),
	]);
	clearTimeout(forceTimer);
	if (!exited) {
		console.warn(`[dev] ${label} did not exit within 2 seconds; force killing it.`);
		signalChild(active, 'SIGKILL');
		await exit;
	}
}

/** Forward a shutdown signal to a managed child process. */
function signalChild(active, signal) {
	try {
		active.kill(signal);
	}
	catch (error) {
		if (error?.code !== 'ESRCH') {
			throw error;
		}
	}
}

/** Queue api restart without duplicating pending work in the dev tool. */
function scheduleApiRestart() {
	if (shuttingDown) {
		return;
	}

	clearTimeout(restartTimer);
	clearTimeout(apiCrashRestartTimer);
	apiCrashRestartTimer = undefined;
	restartTimer = setTimeout(() => {
		operation = operation
			.catch((error) => {
				console.error('[dev] Previous development operation failed.', error);
			})
			.then(async () => {
				await stopApi(true);
				if (!shuttingDown) {
					try {
						console.log('[dev] Server source changed; rebuilding API.');
						await buildApi();
						if (!shuttingDown) {
							apiCrashAttempts = 0;
							const ready = await startApi();
							if (ready) {
								ensureWebStarted();
							}
						}
					}
					catch (error) {
						console.error('[dev] API build failed; waiting for a source change.', error);
					}
				}
			});
	}, restartDebounceMs);
}

/** Recursive source watchers owned until coordinator shutdown. */
const watchers = watchRoots.map((root) => {
	const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
		if (!filename || /\.(?:ts|json)$/.test(filename)) {
			scheduleApiRestart();
		}
	});
	watcher.on('error', (error) => {
		console.warn(`[dev] Source watching is unavailable for ${root}; restart manually after edits.`);
		console.warn(error);
	});
	return watcher;
});

/** Stop both development servers and exit with the supplied status code. */
async function shutdown(exitCode) {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;
	clearTimeout(restartTimer);
	clearTimeout(apiCrashRestartTimer);
	clearTimeout(apiStableTimer);
	for (const watcher of watchers) {
		watcher.close();
	}

	await operation;
	await Promise.all([stopApi(true), stopChild(webChild, 'web server')]);
	process.exitCode = exitCode;
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
try {
	await buildApi();
	if (!shuttingDown) {
		const apiReady = await startApi();
		if (apiReady) {
			ensureWebStarted();
		}
	}
}
catch (error) {
	console.error('[dev] API build failed; waiting for a source change.', error);
}
