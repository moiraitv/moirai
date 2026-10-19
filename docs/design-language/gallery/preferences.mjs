import { languageCombobox, bindLanguages } from './language.mjs';
import { disclosure } from './form-disclosure.mjs';
import { field, select, actionIcon } from './fixtures.mjs';

/** SubtitlePreferencesEditor policy/rule dependencies and channel-only presentation settings. */
export function subtitlePreferences(channel = true) {
	return `<fieldset class="stack subtitle-reference" data-subtitle-reference><legend>${channel ? 'Subtitles' : 'Subtitles and music video credits'}</legend><div class="subtitle-policies" role="radiogroup" aria-label="Subtitle behavior">${[...(channel ? [] : [['Inherit selection', 'Enclosing program or channel']]), ['Off', 'No ordinary subtitles'], ['Prefer default', 'Prefer an eligible default track'], ['Any matching track', 'Use your language and title rules'], ['Forced only', 'Require the file’s forced flag']].map(([title, detail], index) => `<label class="choice-card"><input type="radio" name="subtitle-policy-${channel ? 'channel' : 'program'}" value="${title === 'Off' ? 'off' : title.toLowerCase()}" ${index === 0 ? 'checked' : ''}>${actionIcon(title === 'Off' ? 'ban' : title === 'Prefer default' ? 'captions' : title === 'Forced only' ? 'shield-check' : 'list-filter')}<strong>${title}</strong><span class="small secondary">${detail}</span></label>`).join('')}</div><section class="stack" data-subtitle-rules><h3>Selection rules</h3><div class="grid"><label>Subtitle language<span class="select-control"><select data-subtitle-language>${channel ? '' : '<option>Inherit language</option>'}<option>Any language</option><option>Specific language</option></select></span></label><label>Subtitle title rule<span class="select-control"><select data-subtitle-title>${channel ? '' : '<option>Inherit title rule</option>'}<option>Any title</option><option>Specific title</option></select></span></label><div data-subtitle-language-value hidden>${languageCombobox(channel ? 'channel-subtitle-language' : 'program-subtitle-language')}</div><label data-subtitle-title-value hidden>Subtitle title contains<input aria-label="Subtitle title contains" maxlength="200" placeholder="For example, Signs or Forced" aria-describedby="specific-title-help"><small id="specific-title-help" data-subtitle-title-error class="error" hidden>Enter 1–200 characters, or choose Any title.</small></label></div><p class="small secondary">Language, title, and policy must all match. A track titled “Forced” still needs the forced flag for Forced only; choose Any matching track to select it by title alone.</p></section>${channel ? disclosure('Presentation', 'Subtitle mode and fonts', 'settings-2', `<div class="grid">${select('Subtitle mode', ['Burn', 'Convert'])}${field('Subtitle fonts folder', '')}</div>`, true) : '<p class="small secondary">Subtitle mode and fonts follow the channel’s Presentation settings.</p>'}${disclosure('Check against media', 'Preview subtitle selection on a video', 'film', `<div class="stack"><p class="small secondary">Uses scanned metadata. Subtitle contents and rendering are not checked.</p>${channel ? '' : select('Preview channel', ['Choose a channel', '24 · Night flight'])}${select('Preview library', ['Choose a library', 'Film library'])}<label>Search preview videos<input type="search" placeholder="Search by title"></label><p class="small secondary">Search for a video to check subtitle selection.</p></div>`)}<section class="reference-credits"><div class="reference-credits-heading"><span class="reference-disclosure-icon">${actionIcon('file-text')}</span><span class="reference-disclosure-copy"><strong>Music video credits</strong><small>Credits for music videos</small></span>${channel ? '<label class="check"><span data-credit-state>Off</span><input type="checkbox" role="switch" class="switch" data-music-credits aria-label="Music video credits"></label>' : '<label><span class="sr-only">Music video credits</span><span class="select-control"><select data-music-credits-choice><option>Inherit</option><option>Off</option><option>On</option></select></span></label>'}</div><div data-credit-settings hidden>${select('Credit template', ['Choose a template', 'Default credits'])}<p class="small secondary">Replace subtitles on music videos. Uses Burn for the whole channel.</p></div></section></fieldset>`;
}

/** Preserve AudioPreferencesEditor's language and track-title matching fields. */
export function audioPreferences(inherit = false) {
	return `<fieldset class="stack"><legend>Audio selection</legend><div class="grid">${field('Preferred language code', inherit ? '' : 'eng')}${field('Preferred audio title', '')}</div><p class="small secondary">Two or three letters, such as en or eng. Track title matches part of the title, ignoring case. If no track matches, playback uses another available audio track.</p></fieldset>`;
}

/** Preserve linked profile versus channel override ownership, including read-only settings. */
export function encodingPreferences() {
	return `<fieldset class="stack" data-encoding-reference><legend>Encoding profile</legend><div class="row">${select('Audio and video settings', ['Default profile', 'Custom'])}<a class="button" href="./docs/audit.md" data-app-path="/playback/encoding-profiles">${actionIcon('settings')}Manage Encoding Profiles</a></div>${disclosure('Video & audio settings', 'Linked profile', 'settings', `<fieldset disabled data-linked-settings><legend>Video</legend><div class="grid">${select('Format', ['H.264', 'HEVC'])}${select('Acceleration', ['Automatic', 'None', 'AMF', 'CUDA', 'QSV', 'RKMPP', 'VAAPI', 'VideoToolbox', 'Vulkan'])}${field('Width', '1920', 'number')}${field('Height', '1080', 'number')}${field('Bitrate kbps', '6000', 'number')}${field('Buffer kbps', '12000', 'number')}${field('Bit depth', '8', 'number')}${select('Scaling', ['Scale and pad', 'Stretch', 'Crop'])}<label class="check"><input type="checkbox">Deinterlace</label><div data-vaapi hidden>${field('VAAPI device', '/dev/dri/renderD128')}${select('VAAPI driver', ['Automatic', 'iHD', 'i965', 'radeonsi'])}</div></div></fieldset><fieldset disabled data-linked-settings><legend>Audio</legend><div class="grid">${select('Format', ['AAC', 'AC3'])}${field('Bitrate kbps', '192', 'number')}${field('Channels', '2', 'number')}${field('Sample rate', '48000', 'number')}</div>${field('Buffer kbps', '384', 'number')}<label class="check"><input type="checkbox" data-normalize>Normalize loudness</label><div class="grid" data-loudness hidden>${field('Integrated loudness (LUFS)', '-16', 'number')}${field('Loudness range (LU)', '11', 'number')}${field('True peak (dBTP)', '-1.5', 'number')}</div></fieldset>`)}</fieldset>`;
}

/** Native draft controls demonstrate dependency visibility without media probing or transcoding. */
export function bindPreferences(root) {
	bindLanguages(root);
	root.querySelectorAll('[data-subtitle-reference]').forEach(section => {
		const update = () => {
			const off = section.querySelector('input[type="radio"]:checked').value === 'off';
			section.querySelector('[data-subtitle-rules]').hidden = off;
			const credits = section.querySelector('[data-music-credits]');
			if (credits) {
				section.querySelector('[data-credit-state]').textContent = credits.checked ? 'On' : 'Off';
			}
			const creditsOn = credits ? credits.checked : section.querySelector('[data-music-credits-choice]').value === 'On';
			section.querySelector('[data-credit-settings]').hidden = !creditsOn;
			const template = section.querySelector('[data-credit-settings] select');
			template.setCustomValidity(creditsOn && template.value === 'Choose a template' ? 'Choose a credit template to enable credits.' : '');
			section.querySelector('[data-subtitle-title-value] input').required = !off && section.querySelector('[data-subtitle-title]').value === 'Specific title';
			const title = section.querySelector('[data-subtitle-title-value] input');
			const invalidTitle = title.required && !title.value.trim();
			title.setCustomValidity(invalidTitle ? 'Enter 1–200 characters, or choose Any title.' : '');
			title.setAttribute('aria-invalid', String(invalidTitle));
			section.querySelector('[data-subtitle-title-error]').hidden = !invalidTitle;
			section.querySelector('[data-subtitle-language-value] input').required = !off && section.querySelector('[data-subtitle-language]').value === 'Specific language';
			section.querySelector('[data-subtitle-language-value]').hidden = off || section.querySelector('[data-subtitle-language]').value !== 'Specific language';
			section.querySelector('[data-subtitle-title-value]').hidden = off || section.querySelector('[data-subtitle-title]').value !== 'Specific title';
		};
		section.addEventListener('change', update);
		section.addEventListener('input', update);
		update();
	});
	root.querySelectorAll('[data-encoding-reference]').forEach(section => section.addEventListener('change', () => {
		section.querySelectorAll('[data-linked-settings]').forEach(fieldset => {
			fieldset.disabled = section.querySelector('select').value !== 'Custom'; 
		});
		const acceleration = section.querySelector('[data-linked-settings] select:nth-of-type(1)');
		section.querySelector('[data-vaapi]').hidden = !['VAAPI', 'QSV'].includes(acceleration.closest('fieldset').querySelectorAll('select')[1].value);
		section.querySelector('[data-loudness]').hidden = !section.querySelector('[data-normalize]').checked;
	}));
}
