import { computed, ref, watch } from 'vue';
import { api } from './api';
import type { HardwareAccelerationPredictionRequest, HardwareAccelerationPrediction } from '@moirai/shared/api-contracts';

/** Display labels for concrete backends returned by automatic prediction. */
const accelerationLabels = {
	amf: 'AMF',
	cuda: 'CUDA',
	qsv: 'QSV',
	rkmpp: 'RKMPP',
	vaapi: 'VAAPI',
	videotoolbox: 'VideoToolbox',
	vulkan: 'Vulkan',
} as const;

/** Format one compact Automatic prediction without exposing server diagnostics in page flow. */
export function formatHardwareAccelerationPrediction(
	prediction: HardwareAccelerationPrediction | undefined,
	loading: boolean,
): string {
	if (loading) {
		return 'Checking…';
	}
	if (prediction?.outcome === 'hardware' && prediction.accel) {
		return accelerationLabels[prediction.accel];
	}
	if (prediction?.outcome === 'none') {
		return 'None';
	}
	if (prediction?.outcome === 'indeterminate') {
		return 'Undetermined';
	}
	return '';
}

/**
 * Predict an open editor's Automatic backend after changes settle. Closing or changing the request
 * cancels pending work and prevents an older response from replacing the current prediction.
 */
export function useHardwareAccelerationPrediction(request: () => HardwareAccelerationPredictionRequest | null) {
	const prediction = ref<HardwareAccelerationPrediction>();
	const loading = ref(false);
	const text = computed(() => formatHardwareAccelerationPrediction(prediction.value, loading.value));

	watch(request, (input, _previous, onCleanup) => {
		prediction.value = undefined;
		loading.value = input !== null;
		if (!input) {
			return;
		}

		let current = true;
		const timer = setTimeout(async () => {
			try {
				const result = await api.predictHardwareAcceleration(input);
				if (current) {
					prediction.value = result;
				}
			}
			catch {
				if (current) {
					prediction.value = { outcome: 'indeterminate', accel: null, detail: 'The server prediction request failed.' };
				}
			}
			finally {
				if (current) {
					loading.value = false;
				}
			}
		}, 350);
		onCleanup(() => {
			current = false;
			clearTimeout(timer);
		});
	}, { immediate: true });

	return { prediction, text };
}
