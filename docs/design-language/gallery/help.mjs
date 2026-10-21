/* global document */
import { icon } from './fixtures.mjs';

/** Existing help.ts and Settings section topic mappings, preserved in the local snapshot. */
const topics = {
	Status: 'operations.status', Logs: 'operations.status',
	Programs: 'scheduling.programs', Libraries: 'libraries.browse', Channels: 'channels.manage',
	'Channel Schedules': 'scheduling.channel-schedules', Guide: 'playback.guide',
	'Playback capacity': 'settings.playback#playback-capacity', Filler: 'settings.playback#filler',
	'Viewing preferences': 'settings.playback#viewing-preferences', 'Playback status': 'settings.playback#playback-status',
	'AI provider': 'settings.ai#ai-provider', 'Backup & Restore': 'settings.backups#backup-and-restore',
	'Automatic Backup': 'settings.backups#automatic-backup', Backups: 'settings.backups#backups',
};

/** Match PageHelpButton's contextual topic and compact visual frame. */
export function helpButton(label, settings = false) {
	return `<button type="button" class="${settings ? 'settings-help' : 'icon page-help'}" aria-label="Help with ${label}" title="Help with ${label}" data-drawer data-help-topic="${topics[label] ?? 'welcome'}">${icon('circle-help')}</button>`;
}

/** Present the source-owned help drawer, actual local topic HTML, review state and full-guide link. */
export function bindHelp() {
	const dialog = document.createElement('dialog');
	dialog.id = 'help-dialog';
	dialog.className = 'help-dialog source-help';
	dialog.setAttribute('aria-label', 'Moirai help');
	document.body.append(dialog);
	let request = 0;
	let opener;
	const load = async (topicId, state) => {
		const revision = ++request;
		dialog.innerHTML = `<header><div class="row">${icon('book-open')}<span>Help · Moirai</span></div><button type="button" class="icon" aria-label="Close help">${icon('x')}</button></header><div class="help-content"><div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span>Loading help…</div></div>`;
		dialog.querySelector('[aria-label="Close help"]').onclick = () => dialog.close();
		if (state === 'loading') {
			return;
		}
		try {
			if (state === 'failed') {
				throw new Error('Contextual help could not be loaded.');
			}
			const response = await fetch('./assets/help/manifest.json');
			if (!response.ok) {
				throw new Error('Contextual help could not be loaded.');
			}
			const manifest = await response.json();
			const topic = manifest.topics[topicId];
			if (!topic) {
				throw new Error('This part of Moirai does not have contextual guidance yet.');
			}
			if (request !== revision || !dialog.open) {
				return;
			}
			dialog.querySelector('header span').textContent = `Help · Moirai ${manifest.guideVersion}`;
			dialog.querySelector('.help-content').innerHTML = `${topic.reviewStatus === 'needs-review' ? '<div class="banner warning" role="status"><strong>This guidance needs review before production.</strong></div>' : ''}<h2 id="help-topic-title">${topic.title}</h2><p class="secondary">${topic.description}</p><div class="help-markdown">${topic.html}</div>`;
			dialog.setAttribute('aria-labelledby', 'help-topic-title');
			dialog.insertAdjacentHTML('beforeend', `<footer><a class="button primary" href="${topic.localPath}" target="_blank" rel="noopener">Open full guide ${icon('arrow-up-right')}</a></footer>`);
		}
		catch (error) {
			if (request !== revision) {
				return;
			}
			dialog.querySelector('.help-content').innerHTML = `<div class="banner danger stack" role="alert"><strong>Help is unavailable</strong><span>${error.message}</span><button type="button">Retry</button></div>`;
			dialog.querySelector('.help-content button').onclick = () => load(topicId);
		}
	};
	document.addEventListener('click', event => {
		const button = event.target.closest('[data-drawer]');
		if (!button) {
			return;
		}
		opener = button;
		dialog.removeAttribute('aria-labelledby');
		dialog.showModal();
		void load(button.dataset.helpTopic ?? 'welcome', button.dataset.helpState);
	});
	dialog.addEventListener('keydown', event => event.stopPropagation());
	dialog.onclick = event => {
		if (event.target === dialog) {
			dialog.close();
		}
	};
	dialog.addEventListener('close', () => {
		request++;
		opener?.focus();
	});
}
