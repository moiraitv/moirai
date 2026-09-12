<script setup lang="ts">
import { Monitor, Volume2 } from '@lucide/vue';
import { computed, watch } from 'vue';
import { useFieldValidation, numericInputAttributes } from '../field-validation';
import { audioNormalizationSchema, videoNormalizationSchema, type ChannelCreate } from '@moirai/shared';

const props = defineProps<{ disabled?: boolean; showDescriptions?: boolean; accelerationPredictionText?: string; accelerationDetail?: string | undefined }>();
const audio = defineModel<ChannelCreate['audio']>('audio', { required: true });
const video = defineModel<ChannelCreate['video']>('video', { required: true });
const emit = defineEmits<{ 'validation-change': [invalid: boolean] }>();
const validation = useFieldValidation(() => {
	const issues = [
		...(audioNormalizationSchema.safeParse(audio.value).error?.issues ?? []).map(issue => ({ ...issue, path: ['audio', ...issue.path] })),
		...(videoNormalizationSchema.safeParse(video.value).error?.issues ?? []).map(issue => ({ ...issue, path: ['video', ...issue.path] })),
	];
	return { success: issues.length === 0, error: { issues } };
});
const invalid = computed(() => !props.disabled && validation.hasErrors.value);
watch(invalid, value => emit('validation-change', value), { immediate: true });
watch(() => [audio.value, video.value], () => validation.reset());
/** Match native numeric controls to their existing normalization constraints. */
const numericFields = {
	'video.width': numericInputAttributes(videoNormalizationSchema.shape.width.removeDefault().unwrap()),
	'video.height': numericInputAttributes(videoNormalizationSchema.shape.height.removeDefault().unwrap()),
	'video.bitrateKbps': numericInputAttributes(videoNormalizationSchema.shape.bitrateKbps.removeDefault().unwrap()),
	'video.bufferKbps': numericInputAttributes(videoNormalizationSchema.shape.bufferKbps.removeDefault().unwrap()),
	'video.bitDepth': numericInputAttributes(videoNormalizationSchema.shape.bitDepth.removeDefault().unwrap()),
	'audio.bitrateKbps': numericInputAttributes(audioNormalizationSchema.shape.bitrateKbps.removeDefault().unwrap()),
	'audio.channels': numericInputAttributes(audioNormalizationSchema.shape.channels.removeDefault().unwrap()),
	'audio.sampleRateHz': numericInputAttributes(audioNormalizationSchema.shape.sampleRateHz.removeDefault().unwrap()),
	'audio.bufferKbps': numericInputAttributes(audioNormalizationSchema.shape.bufferKbps.removeDefault().unwrap()),
	'audio.loudness.integratedTarget': numericInputAttributes(audioNormalizationSchema.shape.loudness.removeDefault().unwrap().shape.integratedTarget.removeDefault().unwrap()),
	'audio.loudness.rangeTarget': numericInputAttributes(audioNormalizationSchema.shape.loudness.removeDefault().unwrap().shape.rangeTarget.removeDefault().unwrap()),
	'audio.loudness.truePeak': numericInputAttributes(audioNormalizationSchema.shape.loudness.removeDefault().unwrap().shape.truePeak.removeDefault().unwrap()),
};
</script>

<template>
	<div class="encoding-settings-sections">
		<fieldset :disabled="disabled" class="encoding-settings-section" aria-label="Video">
			<legend><span class="encoding-profile-icon" aria-hidden="true"><Monitor :size="26" /></span><span>Video<small v-if="showDescriptions">Video encoding and output settings</small></span></legend>
			<div class="form-grid three">
				<label
				><span>Format</span
				><select v-model="video.format">
					<option value="h264">H.264</option>
					<option value="hevc">HEVC</option>
				</select></label
				><label
				><span>Width</span><input v-model.number="video.width" type="number" v-bind="{ ...numericFields['video.width'], ...validation.attributes('video.width') }" /><small v-if="!disabled && validation.error('video.width')" :id="validation.errorId('video.width')" class="field-error">{{ validation.error('video.width') }}</small></label
				><label
				><span>Height</span><input v-model.number="video.height" type="number" v-bind="{ ...numericFields['video.height'], ...validation.attributes('video.height') }" /><small v-if="!disabled && validation.error('video.height')" :id="validation.errorId('video.height')" class="field-error">{{ validation.error('video.height') }}</small></label
				><label
				><span>Bitrate kbps</span
				><input v-model.number="video.bitrateKbps" type="number" v-bind="{ ...numericFields['video.bitrateKbps'], ...validation.attributes('video.bitrateKbps') }" /><small v-if="!disabled && validation.error('video.bitrateKbps')" :id="validation.errorId('video.bitrateKbps')" class="field-error">{{ validation.error('video.bitrateKbps') }}</small></label
				><label
				><span>Buffer kbps</span
				><input v-model.number="video.bufferKbps" type="number" v-bind="{ ...numericFields['video.bufferKbps'], ...validation.attributes('video.bufferKbps') }" /><small v-if="!disabled && validation.error('video.bufferKbps')" :id="validation.errorId('video.bufferKbps')" class="field-error">{{ validation.error('video.bufferKbps') }}</small></label
				><label
				><span>Bit depth</span
				><input v-model.number="video.bitDepth" type="number" v-bind="{ ...numericFields['video.bitDepth'], ...validation.attributes('video.bitDepth') }" /><small v-if="!disabled && validation.error('video.bitDepth')" :id="validation.errorId('video.bitDepth')" class="field-error">{{ validation.error('video.bitDepth') }}</small></label
				><label
				><span>Scaling</span
				><select v-model="video.scalingMode">
					<option value="scale_and_pad">Scale and pad</option>
					<option value="stretch">Stretch</option>
					<option value="crop">Crop</option>
				</select></label
				><label class="acceleration-field">
					<span class="acceleration-heading">
						Acceleration
						<small
							v-if="video.accel === 'automatic' && accelerationPredictionText"
							class="acceleration-prediction"
							role="status"
							:title="accelerationDetail"
						>
							{{ accelerationPredictionText }}
						</small>
					</span>
					<select v-model="video.accel">
						<option value="automatic">Automatic</option>
						<option :value="null">None</option>
						<option value="amf">AMF</option>
						<option value="cuda">CUDA</option>
						<option value="qsv">QSV</option>
						<option value="rkmpp">RKMPP</option>
						<option value="vaapi">VAAPI</option>
						<option value="videotoolbox">VideoToolbox</option>
						<option value="vulkan">Vulkan</option>
					</select>
				</label
				><label class="check"
				><input v-model="video.deinterlace" type="checkbox" /><span>Deinterlace<small v-if="showDescriptions" class="encoding-check-description">Remove interlacing from source video</small></span></label
				>
				<label v-if="video.accel === 'vaapi' || video.accel === 'qsv'"><span>VAAPI device</span><input v-model="video.vaapiDevice" /></label>
				<label v-if="video.accel === 'vaapi' || video.accel === 'qsv'"><span>VAAPI driver</span><select v-model="video.vaapiDriver"><option :value="null">Automatic</option><option value="ihd">iHD</option><option value="i965">i965</option><option value="radeonsi">radeonsi</option></select></label>
			</div>
		</fieldset>
		<fieldset :disabled="disabled" class="encoding-settings-section" aria-label="Audio">
			<legend><span class="encoding-profile-icon" aria-hidden="true"><Volume2 :size="26" /></span><span>Audio<small v-if="showDescriptions">Audio encoding and output settings</small></span></legend>
			<div class="form-grid three">
				<label
				><span>Format</span
				><select v-model="audio.format">
					<option value="aac">AAC</option>
					<option value="ac3">AC3</option>
				</select></label
				><label
				><span>Bitrate kbps</span
				><input v-model.number="audio.bitrateKbps" type="number" v-bind="{ ...numericFields['audio.bitrateKbps'], ...validation.attributes('audio.bitrateKbps') }" /><small v-if="!disabled && validation.error('audio.bitrateKbps')" :id="validation.errorId('audio.bitrateKbps')" class="field-error">{{ validation.error('audio.bitrateKbps') }}</small></label
				><label
				><span>Channels</span
				><input v-model.number="audio.channels" type="number" v-bind="{ ...numericFields['audio.channels'], ...validation.attributes('audio.channels') }" /><small v-if="!disabled && validation.error('audio.channels')" :id="validation.errorId('audio.channels')" class="field-error">{{ validation.error('audio.channels') }}</small></label
				><label
				><span>Sample rate</span
				><input v-model.number="audio.sampleRateHz" type="number" v-bind="{ ...numericFields['audio.sampleRateHz'], ...validation.attributes('audio.sampleRateHz') }" /><small v-if="!disabled && validation.error('audio.sampleRateHz')" :id="validation.errorId('audio.sampleRateHz')" class="field-error">{{ validation.error('audio.sampleRateHz') }}</small></label
				><label class="check"
				><input v-model="audio.normalizeLoudness" type="checkbox" /><span>Normalize loudness<small v-if="showDescriptions" class="encoding-check-description">Keep audio levels consistent</small></span></label
				>
				<label><span>Buffer kbps</span><input v-model.number="audio.bufferKbps" type="number" v-bind="{ ...numericFields['audio.bufferKbps'], ...validation.attributes('audio.bufferKbps') }" /><small v-if="!disabled && validation.error('audio.bufferKbps')" :id="validation.errorId('audio.bufferKbps')" class="field-error">{{ validation.error('audio.bufferKbps') }}</small></label>
				<template v-if="audio.normalizeLoudness && audio.loudness">
					<label><span>Integrated loudness (LUFS)</span><input v-model.number="audio.loudness.integratedTarget" type="number" v-bind="{ ...numericFields['audio.loudness.integratedTarget'], ...validation.attributes('audio.loudness.integratedTarget') }" /><small v-if="!disabled && validation.error('audio.loudness.integratedTarget')" :id="validation.errorId('audio.loudness.integratedTarget')" class="field-error">{{ validation.error('audio.loudness.integratedTarget') }}</small></label>
					<label><span>Loudness range (LU)</span><input v-model.number="audio.loudness.rangeTarget" type="number" v-bind="{ ...numericFields['audio.loudness.rangeTarget'], ...validation.attributes('audio.loudness.rangeTarget') }" /><small v-if="!disabled && validation.error('audio.loudness.rangeTarget')" :id="validation.errorId('audio.loudness.rangeTarget')" class="field-error">{{ validation.error('audio.loudness.rangeTarget') }}</small></label>
					<label><span>True peak (dBTP)</span><input v-model.number="audio.loudness.truePeak" type="number" v-bind="{ ...numericFields['audio.loudness.truePeak'], ...validation.attributes('audio.loudness.truePeak') }" /><small v-if="!disabled && validation.error('audio.loudness.truePeak')" :id="validation.errorId('audio.loudness.truePeak')" class="field-error">{{ validation.error('audio.loudness.truePeak') }}</small></label>
				</template>
			</div>
		</fieldset>
	</div>
</template>
