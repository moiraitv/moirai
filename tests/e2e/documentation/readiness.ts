import type { ChildProcess } from 'node:child_process';

/** Wait for this child's completed bootstrap, never another process's HTTP listener. */
export function waitForDocumentationServer(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error('Documentation server startup timed out')), 30_000);
		/** Release startup listeners on success, failure, or timeout. */
		function finish(error?: Error): void {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('error', onError);
			child.off('exit', onExit);
			if (error) {
				reject(error);
			}
			else {
				resolve();
			}
		}
		/** Accept only the test entry point's post-bootstrap acknowledgement. */
		function onMessage(message: unknown): void {
			if (message && typeof message === 'object' && 'type' in message && message.type === 'documentation-ready') {
				finish();
			}
		}
		/** Surface spawn failures without waiting for the startup deadline. */
		function onError(error: Error): void {
			finish(error);
		}
		/** A child that exits before acknowledgement never owns a ready fixture. */
		function onExit(code: number | null, signal: string | null): void {
			finish(new Error(`Documentation server exited before readiness (${signal ?? code})`));
		}
		child.on('message', onMessage);
		child.once('error', onError);
		child.once('exit', onExit);
		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}
