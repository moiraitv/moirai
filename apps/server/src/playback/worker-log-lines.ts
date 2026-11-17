import { StringDecoder } from 'node:string_decoder';

/** Maximum retained characters in one playback diagnostic line. */
export const PLAYBACK_LOG_LINE_LIMIT = 16 * 1_024;

/**
 * Assemble bounded child-process lines before removing signed playback capabilities.
 * Each stdout/stderr stream owns an instance so split chunks cannot expose partial signatures.
 * Oversized lines retain only their bounded prefix; stream completion flushes the final line.
 */
export class WorkerLogLines {
	private readonly decoder = new StringDecoder('utf8');
	private pending = '';
	private truncated = false;

	constructor(private readonly emit: (message: string) => void) {}

	/** Decode and retain only a bounded prefix until the complete line can be sanitized. */
	write(chunk: Buffer): void {
		this.consume(this.decoder.write(chunk));
	}

	/** Flush an unterminated final line after the stream ends. */
	finish(): void {
		this.consume(this.decoder.end());
		this.flush();
	}

	/** Split decoded output without retaining an unbounded line or mixing adjacent messages. */
	private consume(output: string): void {
		let offset = 0;
		while (offset < output.length) {
			const newline = output.indexOf('\n', offset);
			const finish = newline < 0 ? output.length : newline;
			const remaining = PLAYBACK_LOG_LINE_LIMIT - this.pending.length;
			this.pending += output.slice(offset, Math.min(finish, offset + remaining));
			this.truncated ||= finish - offset > remaining;
			if (newline < 0) {
				return;
			}

			this.flush();
			offset = newline + 1;
		}
	}

	/** Remove complete or truncated signature values before emitting any retained text. */
	private flush(): void {
		const message = this.pending.replace(/(http:\/\/127\.0\.0\.1:\d+\/clock\/)[\w.-]+/gu, '$1[redacted]').replace(/([?&]sig=)[^&\s"'<>]*/gu, '$1[Redacted]').trim();
		if (message) {
			this.emit(this.truncated ? `${message} [truncated]` : message);
		}

		this.pending = '';
		this.truncated = false;
	}
}
