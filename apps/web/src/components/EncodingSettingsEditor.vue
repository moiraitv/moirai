<script setup lang="ts">
import { Monitor, Volume2 } from '@lucide/vue';
import type { ChannelCreate } from '@moirai/shared';

defineProps<{ disabled?: boolean; showDescriptions?: boolean; accelerationPredictionText?: string; accelerationDetail?: string | undefined }>();
const audio = defineModel<ChannelCreate['audio']>('audio', { required: true });
const video = defineModel<ChannelCreate['video']>('video', { required: true });
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
				><span>Width</span><input v-model.number="video.width" type="number" /></label
				><label
				><span>Height</span><input v-model.number="video.height" type="number" /></label
				><label
				><span>Bitrate kbps</span
				><input v-model.number="video.bitrateKbps" type="number" /></label
				><label
				><span>Buffer kbps</span
				><input v-model.number="video.bufferKbps" type="number" /></label
				><label
				><span>Bit depth</span
				><input v-model.number="video.bitDepth" type="number" /></label
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
				><input v-model.number="audio.bitrateKbps" type="number" /></label
				><label
				><span>Channels</span
				><input v-model.number="audio.channels" type="number" /></label
				><label
				><span>Sample rate</span
				><input v-model.number="audio.sampleRateHz" type="number" /></label
				><label class="check"
				><input v-model="audio.normalizeLoudness" type="checkbox" /><span>Normalize loudness<small v-if="showDescriptions" class="encoding-check-description">Keep audio levels consistent</small></span></label
				>
				<label><span>Buffer kbps</span><input v-model.number="audio.bufferKbps" type="number" /></label>
				<template v-if="audio.normalizeLoudness && audio.loudness">
					<label><span>Integrated loudness (LUFS)</span><input v-model.number="audio.loudness.integratedTarget" type="number" step="0.1" /></label>
					<label><span>Loudness range (LU)</span><input v-model.number="audio.loudness.rangeTarget" type="number" step="0.1" /></label>
					<label><span>True peak (dBTP)</span><input v-model.number="audio.loudness.truePeak" type="number" step="0.1" /></label>
				</template>
			</div>
		</fieldset>
	</div>
</template>
