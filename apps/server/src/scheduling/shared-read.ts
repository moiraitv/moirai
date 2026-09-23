/** In-flight read shared by callers without allowing one cancellation to abort another consumer. */
export interface SharedRead<T> {
	promise: Promise<T>;
	controller: AbortController;
	consumers: number;
}

/** Release a shared read subscription and cancel abandoned queued work when its last caller leaves. */
export function consumeRead<T>(read: SharedRead<T>, signal?: AbortSignal): Promise<T> {
	read.consumers += 1;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (): boolean => {
			if (settled) {
				return false;
			}
			settled = true;
			signal?.removeEventListener('abort', abort);
			read.consumers -= 1;
			if (read.consumers === 0) {
				read.controller.abort();
			}
			return true;
		};
		const abort = (): void => {
			if (finish()) {
				reject(new DOMException('Request cancelled', 'AbortError'));
			}
		};
		signal?.addEventListener('abort', abort, { once: true });
		read.promise.then(value => {
			if (finish()) {
				resolve(value);
			}
		}, error => {
			if (finish()) {
				reject(error);
			}
		});
		if (signal?.aborted) {
			abort();
		}
	});
}
