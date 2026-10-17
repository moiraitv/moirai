import { computed, onScopeDispose, ref, watch } from 'vue';
import { z } from 'zod';
import { randomUuid } from '../random-uuid';
import { useAuthenticationStore } from '../stores/authentication';
import { readDraftFiles, writeDraftFiles } from '../resource-draft-files';

/** Version recovery data independently of server contracts, including incomplete form values. */
const envelopeSchema = z.object({
	version: z.literal(1), baseline: z.string(), fields: z.json(),
	fileRevision: z.string().nullable(),
});

/** Editable fields and optional local files owned by one resource editor. */
interface ResourceDraftOptions<T> {
	kind: string | (() => string);
	identity: () => string;
	/** Recognize nullable fields without requiring an unfinished draft to pass save validation. */
	nullableSchema?: z.ZodType;
	capture: () => T;
	restore: (fields: T) => void;
	restoreNewBaseline?: (baseline: string) => void;
	dirty: () => boolean;
	files?: () => Record<string, File>;
	restoreFiles?: (files: Record<string, File>) => void | Promise<void>;
}

/** Follow shared contracts to determine whether a particular draft field can be cleared. */
function acceptsNull(schema: z.core.$ZodType | undefined, path: string[]): boolean {
	if (!schema) {
		return false;
	}
	if (!path.length) {
		return z.safeParse(schema, null).success;
	}
	if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable
		|| schema instanceof z.ZodDefault || schema instanceof z.ZodLazy) {
		return acceptsNull(schema.unwrap(), path);
	}
	if (schema instanceof z.ZodUnion) {
		return schema.options.some(option => acceptsNull(option, path));
	}
	const [field, ...rest] = path;
	if (schema instanceof z.ZodObject) {
		return acceptsNull(schema.shape[field!], rest);
	}
	if (schema instanceof z.ZodArray) {
		return acceptsNull(schema.element, rest);
	}
	return false;
}

/** Check recovery structure without rejecting unfinished numbers, names, or authored sequences. */
function compatible(value: unknown, sample: unknown, schema?: z.ZodType, path: string[] = [], required = true): boolean {
	if (value === null) {
		return sample === null || acceptsNull(schema, path);
	}
	if (sample === null || sample === undefined) {
		return true;
	}
	if (Array.isArray(sample)) {
		return Array.isArray(value) && value.every(entry => sample.length
			? sample.some(shape => compatible(entry, shape, schema, [...path, '*'], false))
			: entry !== null || acceptsNull(schema, [...path, '*']));
	}
	if (typeof sample === 'object') {
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			&& Object.entries(sample).every(([key, field]) => Object.hasOwn(value, key)
				? compatible((value as Record<string, unknown>)[key], field, schema, [...path, key], false)
				: !required || field === undefined);
	}
	return typeof value === typeof sample || (typeof sample === 'number' && value === '');
}

/** Build the browser recovery identity shared by editors and collection deletion actions. */
export function resourceDraftStorageKey(account: string, kind: string, identity: string): string {
	return `moirai:resource-draft:${account}:${kind}:${identity}`;
}

/**
 * Retain incomplete browser-local edits without committing resource changes. Files are stored only
 * when selections change; callers flush before dismissal and protect work if persistence fails.
 */
export function useResourceDraft<T>(options: ResourceDraftOptions<T>) {
	const authentication = useAuthenticationStore();
	const warning = ref('');
	const failed = ref(false);
	const restoring = ref(false);
	const restored = ref(false);
	// A success notice waits for file recovery too; restored fields alone can be incomplete.
	const recovered = ref(false);
	const pendingFiles = ref(false);
	let activeKey = '';
	let baseline = '';
	let ready = false;
	let revision = 0;
	let fileRevision: string | null = null;
	let previousFiles: Record<string, File> = {};
	let fileWork: Promise<void> = Promise.resolve();
	const unsafe = computed(() => failed.value || restoring.value || pendingFiles.value);

	/** Scope drafts to the signed-in identity, resource family, and permalink identity. */
	function key(): string {
		const kind = typeof options.kind === 'function' ? options.kind() : options.kind;
		return resourceDraftStorageKey(authentication.state?.identity?.id ?? 'anonymous', kind, options.identity());
	}

	/** Stop observing an old draft before initialization, reset, or destructive cleanup. */
	function pause(): void {
		ready = false;
		revision += 1;
	}

	/** Retain current fields synchronously and queue file changes before leaving the page. */
	function persist(): void {
		if (!ready || !activeKey) {
			return;
		}
		try {
			const files = options.files?.() ?? {};
			const changed = Object.keys(files).length !== Object.keys(previousFiles).length
				|| Object.entries(files).some(([name, file]) => previousFiles[name] !== file);
			if (changed) {
				previousFiles = { ...files };
				fileRevision = randomUuid();
				const owner = revision;
				const selectionRevision = fileRevision;
				pendingFiles.value = true;
				fileWork = writeDraftFiles(activeKey, fileRevision, files).then(() => {
					if (owner === revision && fileRevision === selectionRevision) {
						pendingFiles.value = false;
					}
				}).catch(() => {
					if (owner === revision && fileRevision === selectionRevision) {
						failed.value = true;
						pendingFiles.value = false;
						warning.value = 'Selected files could not be retained in this browser. Keep this editor open or save your changes.';
					}
				});
			}
			if (options.dirty() || fileRevision) {
				localStorage.setItem(activeKey, JSON.stringify({ version: 1, baseline,
					fields: options.capture(), fileRevision }));
			}
			else {
				localStorage.removeItem(activeKey);
			}
		}
		catch {
			failed.value = true;
			warning.value = 'Changes could not be retained in this browser. Keep this editor open or save your changes.';
		}
	}

	/** Restore after the caller has initialized authoritative fields and its dirty-state baseline. */
	async function open(version: string, restore = true): Promise<void> {
		pause();
		const owner = revision;
		activeKey = key();
		baseline = version;
		fileRevision = null;
		previousFiles = {};
		warning.value = '';
		failed.value = false;
		restored.value = false;
		recovered.value = false;
		pendingFiles.value = false;
		restoring.value = true;
		try {
			const raw = restore ? localStorage.getItem(activeKey) : null;
			if (raw) {
				const draft = envelopeSchema.parse(JSON.parse(raw, (name, value: unknown) => {
					if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
						throw new Error('Unsafe browser draft');
					}
					return value;
				}));
				if (!compatible(draft.fields, options.capture(), options.nullableSchema)) {
					throw new Error('Incompatible browser draft');
				}
				baseline = draft.baseline;
				if (options.identity().startsWith('new')) {
					options.restoreNewBaseline?.(draft.baseline);
				}
				restored.value = true;
				options.restore(draft.fields as T);
				fileRevision = draft.fileRevision;
				if (fileRevision && options.restoreFiles) {
					const files = await readDraftFiles(activeKey, fileRevision);
					if (owner !== revision) {
						return;
					}
					await options.restoreFiles(files);
					previousFiles = options.files?.() ?? {};
				}
				if (draft.baseline !== version && !options.identity().startsWith('new')) {
					warning.value = 'The saved resource changed. Review your restored draft before saving.';
				}
				recovered.value = true;
			}
		}
		catch {
			if (owner === revision) {
				failed.value = true;
				warning.value = 'The browser draft could not be fully restored. Review your changes before saving or closing.';
			}
		}
		finally {
			if (owner === revision) {
				restoring.value = false;
				ready = true;
			}
		}
	}

	/** Finish outstanding file retention before a route change or modal dismissal. */
	async function flush(): Promise<boolean> {
		persist();
		await fileWork;
		return !unsafe.value;
	}

	/** Remove recovery data after a commit, reset, confirmed discard, or deletion. */
	function clear(): void {
		pause();
		try {
			localStorage.removeItem(activeKey || key());
			if (options.files) {
				void writeDraftFiles(activeKey || key(), null, {}).catch(() => {});
			}
			warning.value = '';
			failed.value = false;
		}
		catch {
			failed.value = true;
			warning.value = 'The browser draft could not be cleared.';
		}
	}

	watch(() => [options.capture(), options.files?.(), options.dirty()], persist, { deep: true, flush: 'sync' });
	/** Adopt asynchronously loaded defaults without treating initialization as user edits. */
	function setBaseline(version: string): void {
		baseline = version;
		persist();
	}

	onScopeDispose(pause);
	return { warning, unsafe, restoring, restored, recovered, open, pause, persist, flush, clear, setBaseline };
}
