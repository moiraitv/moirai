import { effectScope, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HardwareAccelerationPrediction, HardwareAccelerationPredictionRequest } from '@moirai/shared/api-contracts';
import { api } from '@web/api';
import { useHardwareAccelerationPrediction } from '@web/channel-acceleration';

vi.mock('@web/api', () => ({ api: { predictHardwareAcceleration: vi.fn() } }));
const scopes: ReturnType<typeof effectScope>[] = [];
const request: HardwareAccelerationPredictionRequest = {
	format: 'h264', bitDepth: 8, width: 1280, height: 720, vaapiDevice: null, vaapiDriver: null, ffmpegPath: null,
};
const hardware: HardwareAccelerationPrediction = { outcome: 'hardware', accel: 'qsv', detail: 'Available' };

function setup() {
	vi.useFakeTimers();
	const scope = effectScope();
	scopes.push(scope);
	const input = ref<HardwareAccelerationPredictionRequest | null>(null);
	const state = scope.run(() => useHardwareAccelerationPrediction(() => input.value && { ...input.value }))!;
	return { scope, input, ...state };
}

afterEach(() => {
	for (const scope of scopes.splice(0)) {
		scope.stop();
	}
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe('editor acceleration predictions', () => {
	it('debounces changed settings and retains an explicit channel FFmpeg override', async () => {
		const { input, text } = setup();
		vi.mocked(api.predictHardwareAcceleration).mockResolvedValue(hardware);
		expect(text.value).toBe('');
		input.value = request;
		await nextTick();
		expect(text.value).toBe('Checking…');
		await vi.advanceTimersByTimeAsync(200);
		input.value = { ...request, width: 1920, ffmpegPath: '/custom/ffmpeg' };
		await nextTick();
		await vi.advanceTimersByTimeAsync(350);
		expect(api.predictHardwareAcceleration).toHaveBeenCalledExactlyOnceWith(input.value);
		expect(text.value).toBe('QSV');
	});

	it('uses the latest response and clears results when Automatic or the editor closes', async () => {
		const { input, prediction, text } = setup();
		let resolveOld!: (value: HardwareAccelerationPrediction) => void;
		vi.mocked(api.predictHardwareAcceleration).mockImplementationOnce(() => new Promise((resolve) => {
			resolveOld = resolve;
		})).mockResolvedValue({ outcome: 'none', accel: null, detail: 'Software' });
		input.value = request;
		await nextTick();
		await vi.advanceTimersByTimeAsync(350);
		input.value = { ...request, width: 1920 };
		await nextTick();
		await vi.advanceTimersByTimeAsync(350);
		resolveOld(hardware);
		await vi.advanceTimersByTimeAsync(0);
		expect(text.value).toBe('None');
		input.value = null;
		await nextTick();
		expect(text.value).toBe('');
		expect(prediction.value).toBeUndefined();
	});

	it('reports failed requests and cancels pending work on disposal', async () => {
		const { scope, input, text } = setup();
		vi.mocked(api.predictHardwareAcceleration).mockRejectedValue(new Error('offline'));
		input.value = request;
		await nextTick();
		await vi.advanceTimersByTimeAsync(350);
		expect(text.value).toBe('Undetermined');
		input.value = { ...request, height: 1080 };
		await nextTick();
		scope.stop();
		await vi.advanceTimersByTimeAsync(350);
		expect(api.predictHardwareAcceleration).toHaveBeenCalledTimes(1);
	});
});
