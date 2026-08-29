import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { LogEntry, LogFile, LogLevel, LogPage } from '@moirai/shared';

/** Filename pattern for retained structured JSONL logs. */
const LOG_FILE_PATTERN = /^moirai-(\d{4}-\d{2}-\d{2})-([\w-]+)\.jsonl$/;
/** Maximum retained bytes inspected by one bounded log query. */
const LOG_SCAN_MAX_BYTES = 32 * 1024 * 1024;
/** Maximum bytes accepted from one structured log line. */
const LOG_LINE_MAX_BYTES = 256 * 1024;
/** Numeric logger levels mapped to their public names. */
const LEVEL_NAMES: Record<number, LogLevel> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal',
};

/** Stable file position used to continue a paged log query. */
interface LogCursor {
	files: Array<{ name: string; size: number }>;
	fileIndex: number;
	lineIndex: number;
}

/** Severity, text, time, and cursor filters for reading operational logs. */
export interface LogQuery {
	cursor?: string | undefined;
	level?: LogLevel | undefined;
	search?: string | undefined;
	limit: number;
}

/** Extract the calendar date encoded in a retained log filename. */
function fileDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Truncate untrusted text to its documented storage or output limit. */
function boundedText(value: unknown, maximum: number): string {
	return String(value ?? '').slice(0, maximum);
}

/** Encode a log file position as an opaque client cursor. */
function encodeCursor(cursor: LogCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Decode and validate an opaque log cursor. */
function decodeCursor(value: string): LogCursor | null {
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as LogCursor;
		if (
			!Array.isArray(parsed.files)
			|| !Number.isInteger(parsed.fileIndex)
			|| parsed.fileIndex < 0
			|| !Number.isInteger(parsed.lineIndex)
			|| parsed.lineIndex < 0
			|| parsed.files.some(
				(file) =>
					typeof file?.name !== 'string'
					|| !Number.isInteger(file.size)
					|| file.size < 0,
			)
		) {
			return null;
		}

		return parsed;
	}
	catch {
		return null;
	}
}

/**
 * Persist structured log records as bounded JSONL files. This writable stream serializes appends,
 * rotates output by date and size, and prunes retained files against age and total-size limits.
 */
class RotatingLogStream extends Writable {
	private currentDate = '';
	private currentPath = '';
	private currentSize = 0;
	private initialized = false;

	constructor(
		private readonly directory: string,
		private readonly fileMaxBytes: number,
		private readonly retentionDays: number,
		private readonly totalMaxBytes: number,
	) {
		super();
	}

	/** Resolve the filesystem path for active. */
	get activePath(): string {
		return this.currentPath;
	}

	/** Accept a stream write and report completion through its callback. */
	override _write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		void this.writeChunk(data).then(() => callback(), callback);
	}

	/** Append one log chunk after ensuring the active file can accept it. */
	private async writeChunk(data: Buffer): Promise<void> {
		await this.ensureCurrent(data.length);
		await appendFile(this.currentPath, data, { mode: 0o600 });
		this.currentSize += data.length;
	}

	/** Rotate the active log when its date or size boundary changes. */
	private async ensureCurrent(nextBytes: number): Promise<void> {
		const date = fileDate();
		if (
			this.initialized
			&& this.currentDate === date
			&& this.currentSize + nextBytes <= this.fileMaxBytes
		) {
			return;
		}

		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		this.currentDate = date;
		this.currentPath = path.join(
			this.directory,
			`moirai-${date}-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}.jsonl`,
		);
		this.currentSize = 0;
		this.initialized = true;
		await this.prune();
	}

	/** Delete log files older than the configured retention period. */
	async prune(): Promise<void> {
		const cutoff = Date.now() - this.retentionDays * 86_400_000;
		const files = await listLogFiles(this.directory, this.currentPath);
		let total = files.reduce((sum, file) => sum + file.size, 0);
		for (const file of [...files].sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt))) {
			if (file.name === path.basename(this.currentPath)) {
				continue;
			}

			if (new Date(file.modifiedAt).getTime() >= cutoff && total <= this.totalMaxBytes) {
				continue;
			}

			await unlink(path.join(this.directory, file.name)).catch(() => undefined);
			total -= file.size;
		}
	}
}

/** List retained log files from newest to oldest. */
async function listLogFiles(directory: string, activePath = ''): Promise<LogFile[]> {
	try {
		const names = await readdir(directory);
		const files: LogFile[] = [];
		for (const name of names) {
			if (!LOG_FILE_PATTERN.test(name)) {
				continue;
			}

			const info = await stat(path.join(directory, name));
			if (info.isFile()) {
				files.push({
					name,
					size: info.size,
					modifiedAt: info.mtime.toISOString(),
					active: path.basename(activePath) === name,
				});
			}
		}
		return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}

		throw error;
	}
}

/** Parse one JSON log line, returning null for malformed input. */
function parseEntry(line: string, file: string, lineIndex: number): LogEntry | null {
	if (!line || Buffer.byteLength(line) > LOG_LINE_MAX_BYTES) {
		return null;
	}

	try {
		const record = JSON.parse(line) as Record<string, unknown>;
		const numericLevel = typeof record.level === 'number' ? record.level : 30;
		const level = LEVEL_NAMES[numericLevel] ?? 'info';
		const timeValue = typeof record.time === 'number' ? record.time : Date.parse(String(record.time));
		const requestId = record.reqId ?? record.requestId;
		const context = { ...record };
		for (const key of ['level', 'time', 'msg', 'pid', 'hostname', 'reqId', 'requestId']) {
			delete context[key];
		}
		return {
			id: `${file}:${lineIndex}`,
			time: new Date(Number.isFinite(timeValue) ? timeValue : 0).toISOString(),
			level,
			message: boundedText(record.msg, 16_384),
			requestId: typeof requestId === 'string' ? requestId.slice(0, 256) : null,
			context,
		};
	}
	catch {
		return null;
	}
}

/**
 * Own the structured application logger and its retained on-disk history. The service redacts
 * sensitive fields before output and exposes bounded snapshot reads, filtered pagination, downloads,
 * pruning, and orderly flushing.
 */
export class LogService {
	readonly logger: Logger;
	private readonly stream: RotatingLogStream;

	constructor(
		private readonly directory: string,
		level: string,
		fileMaxBytes: number,
		retentionDays: number,
		totalMaxBytes: number,
	) {
		this.stream = new RotatingLogStream(directory, fileMaxBytes, retentionDays, totalMaxBytes);
		const destination
			= level === 'silent'
				? this.stream
				: pino.multistream([{ stream: process.stdout }, { stream: this.stream }]);
		this.logger = pino(
			{
				level,
				redact: {
					paths: [
						'req.headers.authorization',
						'req.headers.cookie',
						'res.headers.set-cookie',
						'password',
						'token',
						'logout_token',
						'csrfToken',
						'providerLogoutHint',
						'codeVerifier',
						'secret',
						'*.password',
						'*.token',
						'*.secret',
					],
					censor: '[Redacted]',
				},
				serializers: {
					/** Normalize an attached error before writing structured context. */
					err(error: Error) {
						return {
							type: boundedText(error.name, 256),
							message: boundedText(error.message, 16_384),
							stack: boundedText(error.stack, 32_768),
							code: boundedText((error as NodeJS.ErrnoException).code, 128) || undefined,
						};
					},
				},
			},
			destination,
		);
	}

	/** List retained log files in newest-first order. */
	async files(): Promise<LogFile[]> {
		return listLogFiles(this.directory, this.stream.activePath);
	}

	/** Read one bounded page of structured log entries. */
	async page(query: LogQuery): Promise<LogPage> {
		// Validate or create a stable snapshot of retained files for cursor pagination.
		const snapshot = query.cursor ? decodeCursor(query.cursor) : null;
		if (query.cursor && !snapshot) {
			throw new Error('Invalid log cursor');
		}

		const cursor: LogCursor = snapshot ?? {
			files: (await this.files()).map(({ name, size }) => ({ name, size })),
			fileIndex: 0,
			lineIndex: 0,
		};
		const retainedNames = new Set((await this.files()).map((file) => file.name));
		if (cursor.files.some((file) => !LOG_FILE_PATTERN.test(file.name))) {
			throw new Error('Invalid log cursor');
		}

		// Scan newest-first within the byte budget while applying filters.
		const entries: LogEntry[] = [];
		const search = query.search?.toLocaleLowerCase() ?? '';
		let scannedBytes = 0;
		let fileIndex = cursor.fileIndex;
		let lineIndex = cursor.lineIndex;
		while (fileIndex < cursor.files.length && scannedBytes < LOG_SCAN_MAX_BYTES) {
			const file = cursor.files[fileIndex]!;
			if (!retainedNames.has(file.name)) {
				fileIndex += 1;
				lineIndex = 0;
				continue;
			}

			const bytes = Math.min(file.size, LOG_SCAN_MAX_BYTES - scannedBytes);
			const handle = await open(path.join(this.directory, file.name), 'r');
			const buffer = Buffer.alloc(bytes);
			try {
				await handle.read(buffer, 0, bytes, 0);
			}
			finally {
				await handle.close();
			}
			scannedBytes += bytes;
			const lines = buffer.toString('utf8').split('\n').filter(Boolean).reverse();
			for (; lineIndex < lines.length; lineIndex += 1) {
				const entry = parseEntry(lines[lineIndex]!, file.name, lineIndex);
				if (!entry || (query.level && entry.level !== query.level)) {
					continue;
				}

				if (
					search
					&& !`${entry.message} ${JSON.stringify(entry.context)}`.toLocaleLowerCase().includes(search)
				) {
					continue;
				}

				entries.push(entry);
				if (entries.length >= query.limit) {
					lineIndex += 1;
					return {
						entries,
						nextCursor: encodeCursor({ ...cursor, fileIndex, lineIndex }),
						scannedBytes,
						scanLimitReached: false,
					};
				}
			}
			fileIndex += 1;
			lineIndex = 0;
		}

		// Preserve the next scan position when the byte limit stops this page early.
		const hasMore = fileIndex < cursor.files.length;
		return {
			entries,
			nextCursor: hasMore ? encodeCursor({ ...cursor, fileIndex, lineIndex }) : null,
			scannedBytes,
			scanLimitReached: hasMore,
		};
	}

	/** Open a validated retained log file for download. */
	async download(name: string): Promise<NodeJS.ReadableStream | null> {
		if (!LOG_FILE_PATTERN.test(name)) {
			return null;
		}

		const file = (await this.files()).find((candidate) => candidate.name === name);
		return file ? createReadStream(path.join(this.directory, name)) : null;
	}

	/** Delete expired on-disk log files. */
	async prune(): Promise<void> {
		await this.stream.prune();
	}

	/** Flush buffered log records and close the output stream. */
	async close(): Promise<void> {
		this.logger.flush();
		if (!this.stream.writableEnded) {
			await new Promise<void>((resolve) => this.stream.end(resolve));
		}
	}
}
