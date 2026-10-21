import { helpButton } from './help.mjs';
/* global document, window */
import { bindTwoStep } from './two-step.mjs';
import { field, select, icon } from './fixtures.mjs';

/** Render working settings tabs with retained drafts and saved-value disclosures. */
export function settingsLayout() {
	const sections = [['playback', 'Playback'], ['ai', 'AI'], ['backups', 'Backups']];
	return `<div data-settings><div class="tabs settings-tabs" role="tablist" aria-label="Settings sections">${sections.map(([id, label], index) => `<button id="${id}-tab" role="tab" aria-controls="${id}-panel" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}<span data-dirty hidden aria-label="Unsaved changes">●</span></button>`).join('')}</div>
	<section id="playback-panel" role="tabpanel" aria-labelledby="playback-tab" tabindex="0">
	<div class="panel settings-readiness"><div class="settings-readiness-title"><span class="pill success">Ready</span><strong>2 / 4 streams active</strong>${settingsHelp('Playback status')}</div><div class="row settings-readiness-actions"><button type="button" data-refresh-status>${icon('refresh-cw')}Refresh Status</button><button type="button" data-engine-toggle aria-expanded="false" aria-controls="settings-engine-details" aria-describedby="settings-engine-details">Engine details${icon('chevron-down')}</button></div><div id="settings-engine-details" popover="auto" role="tooltip"><span>Engine version · local fixture</span><code>Contract revision · local fixture</code></div></div>
	<div class="stack settings-form"><section class="panel" data-settings-section>${settingsHeading('Playback capacity', 'monitor-play', 'Set how many channel streams can play at once.')}<label>Maximum active channel sessions<input type="number" value="4" min="1" max="32" required><small>Additional tune requests receive a retryable capacity response. Default: 4.</small></label></section>
	<section class="panel" data-settings-section>${settingsHeading('Filler', 'clapperboard')}<details><summary>Break budget warnings <span class="muted">Below 80%</span></summary><label>Warn when filler supplies less than (%)<input type="range" min="0" max="100" value="80"></label><details><summary>How warnings work</summary><p>Use 0 to disable budget-shortfall warnings or 100 to warn about any incomplete break.</p></details></details><details><summary>Global fallback filler <span class="muted">Bundled Moirai fallback</span></summary><p>Used when a channel has no channel-specific fallback and its schedule leaves time uncovered.</p><button type="button">Choose video</button></details></section>
	<section class="panel" data-settings-section>${settingsHeading('Viewing preferences', 'heart', 'Use anonymous viewing history in future selections. Network addresses and client details are never stored.')}<label class="check"><input type="checkbox" checked>Learn from channel viewing</label><div class="row settings-actions"><button type="button">View Current Scores</button></div></section></div>${settingsFooter('Playback')}</section>
	<section id="ai-panel" role="tabpanel" aria-labelledby="ai-tab" tabindex="0" hidden><section class="panel stack" data-settings-section><div class="row ai-reference-heading">${settingsHeading('AI provider', 'brain-circuit', 'Choose a provider and enter its API key. Provider charges and results vary by model.').replace('<h3>AI provider</h3>', '<h3><button type="button" class="ai-reference-title" data-ai-advanced-toggle aria-expanded="false" aria-controls="ai-reference-advanced">AI provider</button></h3>')}<label class="row ai-reference-enable"><input class="switch" type="checkbox" role="switch" aria-label="Enable AI" data-ai-enabled disabled><strong data-ai-enabled-label>Disabled</strong></label><button type="button" class="ai-reference-handle" data-ai-advanced-toggle aria-label="Toggle advanced AI settings" aria-expanded="false" aria-controls="ai-reference-advanced">${icon('chevron-down')}</button></div><p data-ai-status>AI is off. Saving a provider enables it.</p><div class="grid"><label>Provider<span class="select-control"><select data-ai-provider>${['OpenAI', 'Anthropic', 'xAI', 'OpenRouter', 'Custom'].map(provider => `<option>${provider}</option>`).join('')}</select></span></label><label>API Key<input type="password" autocomplete="off" placeholder="Enter API Key" data-ai-key></label></div><p data-ai-model-summary>Recommended model: <strong>gpt-6.1-sol</strong></p><div id="ai-reference-advanced" class="ai-reference-advanced" hidden><div class="stack">${field('Custom model ID', '')}<div class="grid" data-ai-custom hidden><label>Endpoint base URL<input type="url" placeholder="https://example.com/v1"></label>${select('API format', ['Chat Completions', 'Anthropic Messages'])}<label data-ai-json>JSON mode<span class="select-control"><select><option>JSON object</option><option>JSON schema</option><option>Prompt only</option></select></span></label><label class="check" data-ai-plaintext hidden><input type="checkbox">I understand that HTTP sends the prompt and API key without encryption.</label></div><label class="check"><input type="checkbox" data-ai-research>Use web research when generating</label><label data-ai-time hidden>Web research time limit<span class="select-control"><select><option>5 minutes</option><option>7 minutes</option><option>10 minutes</option><option>15 minutes</option></select></span><small>No new searches start after three minutes. This limit lets work already running finish.</small></label></div></div><p class="banner warning" data-ai-warning role="status" hidden>Provider connection needs attention. The draft is preserved.</p><div class="row settings-actions"><button type="button" data-ai-forget hidden>Forget key</button></div></section>${settingsFooter('AI')}</section>
	<section id="backups-panel" role="tabpanel" aria-labelledby="backups-tab" tabindex="0" hidden><div class="panel stack"><div class="settings-card-title"><h3>Backup &amp; Restore</h3>${settingsHelp('Backup &amp; Restore')}</div><section class="settings-automatic"><div class="settings-automatic-header"><div class="settings-automatic-heading"><span class="settings-card-icon">${icon('settings-2')}</span><div><div class="settings-card-title"><h3><button class="settings-automatic-title" type="button" aria-expanded="false" aria-controls="automatic-backup-content" aria-label="Automatic Backup" data-automatic-toggle>Automatic Backup</button></h3>${settingsHelp('Automatic Backup')}</div><small>Configure automatic backups to protect your configuration.</small></div></div><button type="button" class="settings-automatic-handle" aria-expanded="false" aria-controls="automatic-backup-content" aria-label="Toggle automatic backup details" data-automatic-toggle>${icon('chevron-down')}</button><label class="check"><input type="checkbox" class="switch" role="switch" checked aria-label="Enable automatic backups">Enabled</label><p class="muted">Every day at 3:00 am · Keep 7</p></div><div id="automatic-backup-content" class="stack" hidden><div class="grid"><label>Backup interval (days)<input type="number" value="1" min="1" max="3650" required></label><label>Automatic backups to retain<input type="number" value="7" min="1" max="1000" required></label></div><p>Next run: tomorrow at 3:00 am · America/Los_Angeles</p><p>Storage: /backups</p><p>Manual and pre-restore recovery backups stay until deleted. The newest 3 upgrade recovery backups are kept separately.</p></div></section>${settingsHeading('Backups', 'database', 'Create a backup of your current configuration, import a saved backup, or restore from a backup.')}<div class="row"><button class="primary"><span class="action-glyph action-download" aria-hidden="true"></span><span>Create Backup</span></button><button type="button">${icon('upload')}Import Backup</button></div><div class="table-scroll"><table><caption class="sr-only">Saved backups</caption><thead><tr><th>Name</th><th>Created</th><th>Type</th><th>Size</th><th>Actions</th></tr></thead><tbody><tr><td>moirai-2026-10-19.zip</td><td>Today, 03:00</td><td>Automatic</td><td>1.2 MiB</td><td><div class="row"><a href="./docs/audit.md">Download</a><button type="button">Restore</button><button type="button" class="icon backup-delete" aria-label="Delete backup moirai-2026-10-19.zip" title="Delete backup moirai-2026-10-19.zip" data-backup-delete><span class="action-glyph action-trash-2" aria-hidden="true"></span></button></div></td></tr></tbody></table></div></div>${settingsFooter('Backup')}</section></div>`;
}

/** Pair current Settings section titles with plain icons and compact supporting text. */
function settingsHeading(title, name, subtitle = '') {
	return `<header class="settings-card-heading"><span class="settings-card-icon">${icon(name)}</span><div><div class="settings-card-title"><h3>${title}</h3>${settingsHelp(title)}</div>${subtitle ? `<p class="muted">${subtitle}</p>` : ''}</div></header>`;
}

/** Show the Settings card help affordance without adding another disclosure action. */
function settingsHelp(title) {
	return helpButton(title, true);
}

/** Keep tab-scoped draft actions separate from immediate operations and scrolling fields. */
function settingsFooter(label) {
	return `<footer class="settings-save-footer"><span data-save-state>No unsaved changes</span><div class="row"><button data-settings-reset aria-label="Reset ${label} settings draft" data-confirm-label="Confirm Reset ${label} settings draft" data-confirm-text="Confirm Reset" disabled>Reset</button><button class="primary" data-settings-save aria-label="Save ${label} Settings" disabled><span class="action-glyph action-save" aria-hidden="true"></span><span>Save</span></button></div></footer>`;
}

/** Retain drafts across tabs and save or reset each tab as one unit. */
export function bindSettings() {
	const root = document.querySelector('[data-settings]');
	if (!root) {
		return;
	}
	const engine = root.querySelector('[data-engine-toggle]');
	let enginePosition;
	const dismissEngine = event => {
		const popup = root.querySelector('#settings-engine-details');
		if (popup.matches(':popover-open')) {
			const current = engine.getBoundingClientRect();
			if (event.type === 'scroll' && enginePosition?.left === current.left && enginePosition?.top === current.top) {
				return;
			}
			popup.hidePopover();
		}
	};
	window.addEventListener('scroll', dismissEngine, true);
	window.addEventListener('resize', dismissEngine);
	root.querySelector('#settings-engine-details').addEventListener('toggle', event => {
		engine.setAttribute('aria-expanded', String(event.newState === 'open'));
	});
	engine.onclick = () => {
		const popup = root.querySelector('#settings-engine-details');
		if (popup.matches(':popover-open')) {
			popup.hidePopover();
		}
		else {
			const rect = engine.getBoundingClientRect();
			enginePosition = rect;
			popup.style.left = `${Math.max(16, Math.min(rect.right - 288, window.innerWidth - 304))}px`;
			popup.style.top = `${rect.bottom + 8}px`;
			popup.showPopover();
		}
	};
	const ai = root.querySelector('#ai-panel');
	const enabled = ai.querySelector('[data-ai-enabled]');
	const advancedControls = [...ai.querySelectorAll('[data-ai-advanced-toggle]')];
	advancedControls.forEach(control => {
		control.onclick = () => {
			const expanded = control.getAttribute('aria-expanded') !== 'true';
			advancedControls.forEach(trigger => trigger.setAttribute('aria-expanded', String(expanded)));
			ai.querySelector('#ai-reference-advanced').hidden = !expanded;
		};
	});
	let aiEnabled = false;
	let savedAI = false;
	enabled.onchange = () => {
		aiEnabled = enabled.checked;
		ai.querySelector('[data-ai-enabled-label]').textContent = aiEnabled ? 'Enabled' : 'Disabled';
		ai.querySelector('[data-ai-status]').textContent = aiEnabled ? 'AI is enabled for the saved provider · reference example' : 'AI is off. Saved credentials were retained.';
	};
	const updateAI = () => {
		const custom = ai.querySelector('[data-ai-provider]').value === 'Custom';
		const provider = ai.querySelector('[data-ai-provider]').value;
		const override = [...ai.querySelectorAll('label')].find(label => label.textContent.startsWith('Custom model ID')).querySelector('input');
		override.required = custom;
		const models = { OpenAI: 'gpt-6.1-sol', Anthropic: 'claude-sonnet-5-5', xAI: 'grok-4.7', OpenRouter: 'deepseek/deepseek-v4-pro-0813' };
		ai.querySelector('[data-ai-model-summary]').firstChild.textContent = override.value ? 'Custom model: ' : 'Recommended model: ';
		ai.querySelector('[data-ai-model-summary] strong').textContent = override.value || models[provider] || 'Enter a model ID';
		ai.querySelector('[data-ai-custom]').hidden = !custom;
		ai.querySelectorAll('[data-ai-custom] input, [data-ai-custom] select').forEach(input => {
			input.disabled = !custom; 
		});
		ai.querySelector('[data-ai-key]').required = !custom;
		ai.querySelector('input[type="url"]').required = custom;
		ai.querySelector('[data-ai-time]').hidden = !ai.querySelector('[data-ai-research]').checked;
		ai.querySelector('[data-ai-json]').hidden = ai.querySelector('[data-ai-custom] select').value !== 'Chat Completions';
		ai.querySelector('[data-ai-plaintext]').hidden = !custom || !ai.querySelector('input[type="url"]').value.startsWith('http:');
	};
	ai.addEventListener('change', updateAI);
	ai.addEventListener('input', updateAI);
	updateAI();
	const automatic = [...root.querySelectorAll('[data-automatic-toggle]')];
	automatic.forEach(button => {
		button.onclick = () => {
			const open = button.getAttribute('aria-expanded') !== 'true';
			automatic.forEach(trigger => trigger.setAttribute('aria-expanded', String(open)));
			root.querySelector('#automatic-backup-content').hidden = !open;
		};
	});
	const tabs = [...root.querySelectorAll('[role="tab"]')];
	const activate = index => {
		tabs.forEach((tab, position) => {
			tab.setAttribute('aria-selected', String(position === index));
			tab.tabIndex = position === index ? 0 : -1;
			root.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden = position !== index;
		});
	};
	tabs.forEach((tab, index) => {
		tab.onclick = () => activate(index);
		tab.onkeydown = event => {
			const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
			if (next === undefined) {
				return;
			}
			event.preventDefault();
			activate(next);
			tabs[next].focus();
			tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
		};
	});
	root.querySelectorAll('[role="tabpanel"]').forEach(panel => {
		const inputs = [...panel.querySelectorAll('input:not([data-ai-enabled]), select')];
		const values = () => inputs.map(input => ({ value: input.value, checked: input.checked }));
		let baseline = values();
		const save = panel.querySelector('[data-settings-save]');
		const reset = panel.querySelector('[data-settings-reset]');
		const update = () => {
			const dirty = JSON.stringify(values()) !== JSON.stringify(baseline);
			if (panel.id === 'ai-panel') {
				enabled.disabled = !aiEnabled && (!savedAI || dirty);
			}
			save.disabled = !dirty || !inputs.every(input => input.checkValidity());
			reset.disabled = !dirty;
			panel.querySelector('[data-save-state]').textContent = dirty ? 'Unsaved changes' : 'No unsaved changes';
			root.querySelector(`#${panel.getAttribute('aria-labelledby')} [data-dirty]`).hidden = !dirty;
		};
		panel.addEventListener('input', update);
		panel.addEventListener('change', update);
		bindTwoStep(reset, () => {
			inputs.forEach((input, index) => {
				input.value = baseline[index].value;
				input.checked = baseline[index].checked;
			});
			updateAI();
			update();
		});
		save.onclick = () => {
			baseline = values();
			if (panel.id === 'ai-panel') {
				panel.querySelector('[data-ai-status]').textContent = 'AI is enabled for the saved provider · reference example';
				savedAI = true;
				aiEnabled = true;
				enabled.checked = true;
				ai.querySelector('[data-ai-enabled-label]').textContent = 'Enabled';
				panel.querySelector('[data-ai-forget]').hidden = !panel.querySelector('[data-ai-key]').value;
			}
			update();
		};
	});
}
