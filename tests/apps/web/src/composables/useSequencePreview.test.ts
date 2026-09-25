import { effectScope, nextTick, reactive } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProgramConfig, TimelinePreview } from '@moirai/shared';
import { useSequencePreview } from '@web/composables/useSequencePreview';
import { api } from '@web/api';

vi.mock('@web/api', () => ({ api: { sequencePreview: vi.fn() } }));
const id = '00000000-0000-4000-8000-000000000001';
const result = { startDate: '2026-09-19', days: 1, timeZone: 'UTC', segments: [], issues: [], proposedState: [] } as unknown as TimelinePreview;
const stops: Array<() => void> = [];
afterEach(() => {
	stops.splice(0).forEach(stop => stop());
	vi.useRealTimers();
	vi.resetAllMocks();
});
function setup() {
	vi.useFakeTimers();
	vi.mocked(api.sequencePreview).mockResolvedValue(result);
	const draft = reactive({ name: 'Sequence', config: { type: 'sequence', entries: [{ id, programId: id, count: 1 }], repeat: true } as ProgramConfig });
	const scope = effectScope();
	const preview = scope.run(() => useSequencePreview(() => draft.config, () => id))!;
	stops.push(() => scope.stop());
	return { draft, preview };
}
async function flush() {
	await nextTick();
	await vi.advanceTimersByTimeAsync(500);
}

it('ignores presentation edits, equivalent Ordered, and non-effective seed fields', async () => {
	const { draft } = setup();
	await flush();
	expect(api.sequencePreview).toHaveBeenCalledTimes(1);
	draft.name = '';
	draft.config.audioPreferences = { language: 'en' };
	if (draft.config.type === 'sequence') {
		draft.config.ordering = { type: 'ordered' };
		Object.assign(draft.config.ordering, { seed: 'inactive' });
	}
	await flush();
	expect(api.sequencePreview).toHaveBeenCalledTimes(1);
});

it('debounces relevant edits, retains sample date, and supports manual refresh', async () => {
	const { draft, preview } = setup();
	await flush();
	if (draft.config.type === 'sequence') {
		draft.config.entries[0]!.count = 2;
		draft.config.repeat = false;
	}
	await nextTick();
	expect(preview.stale.value).toBe(true);
	await flush();
	expect(api.sequencePreview).toHaveBeenCalledTimes(2);
	expect(vi.mocked(api.sequencePreview).mock.calls[1]![0]).toMatchObject({ startDate: result.startDate, config: { repeat: false, entries: [{ count: 2 }] } });
	preview.refresh();
	await flush();
	expect(api.sequencePreview).toHaveBeenCalledTimes(3);
});

it('does not cancel in-flight generation for a rename and discards superseded responses', async () => {
	const { draft, preview } = setup();
	let resolve!: (value: TimelinePreview) => void;
	vi.mocked(api.sequencePreview).mockImplementationOnce(() => new Promise(done => {
		resolve = done; 
	}));
	await flush();
	const signal = vi.mocked(api.sequencePreview).mock.calls[0]![1]!;
	draft.name = 'Renamed';
	await flush();
	expect(signal.aborted).toBe(false);
	expect(api.sequencePreview).toHaveBeenCalledTimes(1);
	if (draft.config.type === 'sequence') {
		draft.config.repeat = false;
	}
	await flush();
	expect(signal.aborted).toBe(true);
	resolve({ ...result, startDate: '2000-01-01' });
	await flush();
	expect(preview.preview.value?.startDate).toBe(result.startDate);
});

it('keeps invalid drafts distinct from loading and errors', async () => {
	const { draft, preview } = setup();
	if (draft.config.type === 'sequence') {
		draft.config.entries = [];
	}
	await flush();
	expect(api.sequencePreview).not.toHaveBeenCalled();
	expect(preview.invalid.value).toBe(true);
	expect(preview.queued.value).toBe(false);
});

it('refreshes on references, authored order, counts, mode, repeat, and active seed only', async () => {
	const { draft } = setup();
	await flush();
	if (draft.config.type !== 'sequence') {
		throw new Error('Expected sequence');
	}
	const config = draft.config;
	const changes = [
		() => {
			config.entries[0]!.count = 2; 
		},
		() => {
			config.entries[0]!.programId = '00000000-0000-4000-8000-000000000002'; 
		},
		() => {
			config.entries.push({ id: '00000000-0000-4000-8000-000000000003', programId: id, count: 1 }); 
		},
		() => {
			config.entries.reverse(); 
		},
		() => {
			config.repeat = false; 
		},
		() => {
			config.ordering = { type: 'shuffled-allocations', seed: '' }; 
		},
		() => {
			config.ordering = { type: 'shuffled-allocations', seed: 'new seed' }; 
		},
	];
	for (const [index, change] of changes.entries()) {
		change();
		await flush();
		expect(api.sequencePreview).toHaveBeenCalledTimes(index + 2);
	}
	config.ordering = { type: 'shuffled-allocations', seed: ' new seed ' };
	await flush();
	expect(api.sequencePreview).toHaveBeenCalledTimes(changes.length + 1);
});

it('shows persistent request failures and recovers with Refresh', async () => {
	const { preview } = setup();
	vi.mocked(api.sequencePreview).mockRejectedValueOnce(new Error('Unavailable'));
	await flush();
	expect(preview.error.value).toContain('Unavailable');
	expect(preview.updating.value).toBe(false);
	preview.refresh();
	await flush();
	expect(preview.error.value).toBe('');
	expect(preview.preview.value).not.toBeNull();
});
