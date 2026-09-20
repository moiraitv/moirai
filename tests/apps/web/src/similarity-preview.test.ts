import { effectScope, nextTick, ref } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveEvent, SchedulingProgramStatus } from '@moirai/shared';
import { similarityProgramConfigSchema } from '@moirai/shared';
import { api } from '@web/api';
import { useSimilarityPreview, SIMILARITY_TEXT_DEBOUNCE_MS as TEXT_DELAY,
	SIMILARITY_CONTROL_DEBOUNCE_MS as CONTROL_DELAY, SIMILARITY_REFRESH_INTERVAL_MS as REFRESH_DELAY } from '@web/components/programs/use-similarity-preview';

const events = vi.hoisted(() => ({ listener: undefined as ((event: LiveEvent) => void) | undefined }));
vi.mock('@web/api', () => ({ api: { previewSimilarityProgram: vi.fn() } }));
vi.mock('@web/live-events', () => ({ liveEvents: { subscribe: (listener: (event: LiveEvent) => void) => {
	events.listener = listener;
	return () => {
		events.listener = undefined; 
	};
} } }));
const scopes: ReturnType<typeof effectScope>[] = [];
const ready: SchedulingProgramStatus = { programId: 'sample', health: 'ready', sourceLabel: 'Ready', previewItems: [], availableItemCount: 2, indexedItemCount: 2 };

function setup() {
	vi.useFakeTimers();
	const scope = effectScope();
	scopes.push(scope);
	const softPreferences = ref('');
	const exclusionText = ref('');
	const variety = ref(35);
	const source = ref({ itemIds: ['anchor'] });
	const sourceProgramId = ref('00000000-0000-4000-8000-000000000001');
	const state = scope.run(() => useSimilarityPreview(() => {
		const config = similarityProgramConfigSchema.safeParse({ type: 'similarity', sourceProgramId: sourceProgramId.value,
			softPreferences: softPreferences.value, hardExclusions: exclusionText.value.split(',').map((text) => text.trim()).filter(Boolean), variety: variety.value });
		return config.success ? config.data : null;
	}, () => JSON.stringify([softPreferences.value, exclusionText.value]), () => source.value))!;
	vi.mocked(api.previewSimilarityProgram).mockResolvedValue(ready);
	return { scope, softPreferences, exclusionText, variety, sourceProgramId, source, ...state };
}
function progress() {
	events.listener?.({ type: 'embeddings.changed' } as LiveEvent);
}
afterEach(() => {
	for (const scope of scopes.splice(0)) {
		scope.stop();
	}
	vi.useRealTimers();
	vi.resetAllMocks();
});

it('submits only settled preference text while raw exclusion separators still reset the typing delay', async () => {
	const state = setup();
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	vi.mocked(api.previewSimilarityProgram).mockClear();
	for (const text of ['dark', 'dark science', 'dark science fiction']) {
		state.softPreferences.value = text;
		await nextTick();
		await vi.advanceTimersByTimeAsync(TEXT_DELAY - 1);
		progress();
		expect(api.previewSimilarityProgram).not.toHaveBeenCalled();
	}
	await vi.advanceTimersByTimeAsync(1);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(1);
	expect(vi.mocked(api.previewSimilarityProgram).mock.calls[0]![0].softPreferences).toBe('dark science fiction');
	state.exclusionText.value = 'superhero';
	await nextTick();
	await vi.advanceTimersByTimeAsync(TEXT_DELAY - 1);
	state.exclusionText.value = 'superhero,';
	await nextTick();
	await vi.advanceTimersByTimeAsync(TEXT_DELAY - 1);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
});

it('keeps controls responsive without letting them bypass outstanding text edits', async () => {
	const state = setup();
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	state.variety.value = 50;
	await nextTick();
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	state.softPreferences.value = 'space';
	await nextTick();
	await vi.advanceTimersByTimeAsync(100);
	state.variety.value = 75;
	await nextTick();
	await vi.advanceTimersByTimeAsync(TEXT_DELAY - 101);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(3);
});

it.each(['success', 'rejection'])('aborts superseded requests and ignores their late %s', async (outcome) => {
	const state = setup();
	let rejectOld!: (reason: Error) => void;
	let resolveOld!: (value: SchedulingProgramStatus) => void;
	vi.mocked(api.previewSimilarityProgram).mockImplementationOnce(() => new Promise((resolve, reject) => {
		resolveOld = resolve;
		rejectOld = reject; 
	}));
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	const signal = vi.mocked(api.previewSimilarityProgram).mock.calls[0]![1]!;
	state.softPreferences.value = 'new phrase';
	await nextTick();
	expect(signal.aborted).toBe(true);
	if (outcome === 'success') {
		resolveOld({ ...ready, sourceLabel: 'Stale result' });
	}
	else {
		rejectOld(new Error('Cancelled request'));
	}
	await nextTick();
	expect(state.error.value).toBe('');
	expect(state.preview.value).toBeNull();
	expect(state.loading.value).toBe(true);
	await vi.advanceTimersByTimeAsync(TEXT_DELAY);
	expect(state.preview.value).toEqual(ready);
	expect(state.loading.value).toBe(false);
});

it('coalesces background events, preserves visible results, and serializes refreshes', async () => {
	const state = setup();
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	let resolveRefresh!: (value: SchedulingProgramStatus) => void;
	vi.mocked(api.previewSimilarityProgram).mockImplementationOnce(() => new Promise((resolve) => {
		resolveRefresh = resolve; 
	}));
	for (let index = 0; index < 20; index += 1) {
		progress();
	}
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	expect(state.loading.value).toBe(false);
	progress();
	progress();
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY * 3);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	resolveRefresh(ready);
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY * 3);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(3);
});

it('does not let background progress postpone typing and cancels all work on invalidation or disposal', async () => {
	const state = setup();
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	progress();
	state.softPreferences.value = 'new phrase';
	await nextTick();
	progress();
	await vi.advanceTimersByTimeAsync(TEXT_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	state.sourceProgramId.value = '';
	await nextTick();
	progress();
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY);
	expect(state.preview.value).toBeNull();
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	state.sourceProgramId.value = '00000000-0000-4000-8000-000000000001';
	await nextTick();
	state.scope.stop();
	await vi.advanceTimersByTimeAsync(REFRESH_DELAY);
	expect(api.previewSimilarityProgram).toHaveBeenCalledTimes(2);
	expect(events.listener).toBeUndefined();
});

it('aborts an in-flight preview when the editor closes and ignores its result', async () => {
	const state = setup();
	let resolveRequest!: (value: SchedulingProgramStatus) => void;
	vi.mocked(api.previewSimilarityProgram).mockImplementationOnce(() => new Promise((resolve) => {
		resolveRequest = resolve;
	}));
	await vi.advanceTimersByTimeAsync(CONTROL_DELAY);
	const signal = vi.mocked(api.previewSimilarityProgram).mock.calls[0]![1]!;
	state.scope.stop();
	expect(signal.aborted).toBe(true);
	resolveRequest(ready);
	await nextTick();
	expect(state.preview.value).toBeNull();
	expect(events.listener).toBeUndefined();
});
