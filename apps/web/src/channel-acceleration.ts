import type { HardwareAccelerationPrediction } from '@moirai/shared/api-contracts';

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
