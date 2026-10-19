/* global document, window */
import { actionIcon, detailedChoices, field, select, mediaCarousel, programs } from './fixtures.mjs';
import { helpButton } from './help.mjs';
import { audioPreferences, subtitlePreferences, bindPreferences } from './preferences.mjs';
import { bindTwoStep } from './two-step.mjs';

/** Source-owned counted sequence steps, retaining the user's integrated handles and trash treatment. */
export function authoredSequence() {
	return `<section class="stack" data-sequence><ol class="stack authored-sequence" role="list">${[0, 2].map((program, index) => `<li class="panel sequence-row"><span class="sequence-number" aria-hidden="true">${index + 1}</span><div class="sequence-body"><div class="row sequence-identity"><strong>${programs[program][0]}</strong><span class="pill info">${programs[program][2]}</span></div><div class="grid sequence-fields"><label>Selections<input type="number" min="1" max="10000" value="${index === 0 ? 2 : 1}" required></label><label>Program<span class="select-control"><select>${programs.filter(item => item[2] !== 'Sequence').map(item => `<option ${item === programs[program] ? 'selected' : ''}>${item[0]}</option>`).join('')}</select></span></label></div></div><button type="button" class="icon two-step-delete" aria-label="Remove ${programs[program][0]} source" title="Remove source" data-sequence-remove data-remove-source>${actionIcon('trash-2')}</button><div class="sequence-moves" role="group" aria-label="Reorder ${programs[program][0]}"><button type="button" class="icon" data-sequence-move="up" aria-label="Move ${programs[program][0]} up" ${index === 0 ? 'disabled' : ''}>${actionIcon('arrow-up')}</button><button type="button" class="icon" data-sequence-move="down" aria-label="Move ${programs[program][0]} down" ${index === 1 ? 'disabled' : ''}>${actionIcon('arrow-down')}</button></div></li>`).join('')}</ol><button type="button" data-sequence-add>${actionIcon('plus')}Add Step</button><label class="check"><input type="checkbox" checked>Repeat sequence</label></section>`;
}

/** SequenceGuidePreview is a single sample-day track, not a channel lineup. */
export function sequenceGuidePreview() {
	return '<div class="sequence-guide-scroll" tabindex="0" role="region" aria-label="Sample day timeline, scroll horizontally"><div class="sequence-guide-ruler"><span>00:00</span><span>01:00</span><span>02:00</span><span>03:00</span><span>04:00</span></div><div class="sequence-guide-track"><div><strong>1. Evening cinema</strong><small>00:00–02:00</small></div><div><strong>2. Night flight</strong><small>02:00–03:00</small></div><div><strong>1. Evening cinema</strong><small>03:00–04:00</small></div></div></div><ol class="small secondary"><li>Evening cinema</li><li>Night flight</li></ol>';
}

/** ProgramEditor preserves its fixed type rail, numbered sections and persistent actions. */
export function programEditor() {
	return `<form class="editor-surface program-reference-editor" data-program-editor><header class="editor-header"><div><span class="eyebrow">Edit sequence rule</span><div class="current-title-help"><h2 id="program-editor-title">Edit Program</h2>${helpButton('Programs')}</div><p class="small secondary">Arrange reusable programs in a custom repeating order.</p></div><button type="button" class="program-usage-toggle" data-program-usage aria-expanded="false" aria-controls="program-reference-usage">${actionIcon('git-branch')}Used by</button><button type="button" class="icon" aria-label="Close program editor" data-program-close>${actionIcon('x')}</button></header><div class="editor-body"><div class="program-reference-layout"><aside class="program-type-rail"><h3>Program type</h3><strong>Sequence</strong><p class="small secondary">Arrange programs in a custom order</p></aside><div class="stack"><label>Name<input value="Weekend discoveries" required data-program-name></label><section class="stack"><h3>1 · Sequence steps</h3><p class="secondary">Combine existing programs in a counted custom order.</p>${authoredSequence()}</section><section class="stack"><h3>2 · Ordering</h3><p class="secondary">Choose how the sequence takes selections from its steps.</p>${detailedChoices(true)}<p class="small secondary">Each child program’s Selection and Playback order determine which items it contributes. Sequence ordering arranges those selections; Shuffled allocations and Balanced rotation may change their placement within the cycle.</p><h4>Playback progress</h4><p class="small secondary">When assigned directly to a channel, this program continues from its saved position automatically. In a template, each slot can continue from its saved position or restart each day.</p><label data-sequence-seed hidden>Stable seed<input placeholder="Optional deterministic seed"></label></section><section class="stack"><div class="row between"><h3>Guide preview</h3><button type="button" class="icon" aria-label="Refresh guide preview">${actionIcon('refresh-cw')}</button></div><p class="small secondary">Sample day starting with fresh sequence and child progress. Four hours visible; scroll horizontally to explore the day.</p>${sequenceGuidePreview()}</section><details><summary>3 · Audio and subtitles — optional</summary><p class="secondary">Override inherited audio and subtitle settings for this program.</p>${audioPreferences(true)}${subtitlePreferences(false)}</details></div></div><aside id="program-reference-usage" class="program-reference-usage panel stack" aria-label="Resource usage" hidden><h3>Used by</h3><p>This program is currently used by 1 resource.</p><a href="?layout=schedules">Night flight · Channel · Base program</a><p class="small secondary">Changes affect these direct references. Other channels may be affected indirectly.</p></aside></div><footer class="editor-footer"><button type="button" class="danger" data-program-permanent-delete>${actionIcon('trash-2')}Delete Program</button><div class="row"><button type="button" data-program-reset disabled>Reset</button><button type="button" data-program-save>Close</button></div></footer></form>`;
}

/** Cover Content, Similar Items and Theme with existing source/selection/refinement controls. */
export function programTypeSpecimens() {
	return `<section class="stack panel"><h3>Content · Specific media items</h3><div class="row"><strong>3 selected</strong><button>Review Selection</button></div><p class="small secondary">Maximum selection follows the application contract.</p>${mediaCarousel('Selected media')}${select('Source type', ['Specific media items', 'Library query', 'Specific media groups', 'AI'])}${select('Library', ['Film library'])}${detailedChoices()}<label data-content-seed>Stable seed<input placeholder="Optional deterministic seed"></label></section><section class="stack panel"><h3>Similar Items · Similar item selection</h3><label>Source Program<input value="Evening cinema" readonly></label>${field('Quantity', '10', 'number')}<label>Cohesion / Variety<input type="range" min="0" max="100" value="40"></label><label>Preferences<textarea rows="2">Prefer independent films</textarea></label><label>Exclusions<textarea data-exclusions rows="2" placeholder="Comma-separated concepts to avoid"></textarea></label><label data-exclusion-strictness hidden>Exclusion strictness<input type="range" min="0" max="100" value="50"></label><p class="small secondary">No committed sets reported.</p>${mediaCarousel('Sample matches')}</section><section class="stack panel"><h3>Theme · Theme selection</h3>${select('Target library', ['Film library'])}<label>Theme<textarea rows="3">Space exploration and first contact</textarea></label>${field('Quantity', '10', 'number')}<label>Cohesion / Variety<input type="range" min="0" max="100" value="40"></label><label>Preferences<textarea rows="2"></textarea></label><label>Exclusions<textarea data-exclusions rows="2"></textarea></label><label data-exclusion-strictness hidden>Exclusion strictness<input type="range" min="0" max="100" value="50"></label>${mediaCarousel('Theme sample matches')}</section>`;
}

/** Bind count validity and local step ordering/removal; no application data is changed. */
function bindSequenceSection(section) {
	const list = section.querySelector('ol');
	const update = () => {
		[...list.children].forEach((row, index, rows) => {
			row.querySelector('.sequence-number').textContent = index + 1;
			row.querySelector('[data-sequence-move="up"]').disabled = index === 0;
			row.querySelector('[data-sequence-move="down"]').disabled = index === rows.length - 1;
		});
		section.dispatchEvent(new Event('input', { bubbles: true }));
	};
	const bind = row => {
		bindTwoStep(row.querySelector('[data-sequence-remove]'), () => {
			row.remove();
			update();
		});
		row.querySelector('select').onchange = event => {
			const item = programs.find(item => item[0] === event.target.value);
			row.querySelector('.sequence-identity strong').textContent = item[0];
			row.querySelector('.sequence-identity .pill').textContent = item[2];
		};
	};
	list.querySelectorAll('li').forEach(bind);
	section.addEventListener('click', event => {
		const move = event.target.closest('[data-sequence-move]');
		if (move) {
			const row = move.closest('li');
			if (move.dataset.sequenceMove === 'up') {
				row.previousElementSibling.before(row);
			}
			else {
				row.nextElementSibling.after(row);
			}
			update();
			move.focus();
		}
	});
	section.querySelector('[data-sequence-add]').onclick = () => {
		const temporary = document.createElement('div');
		temporary.innerHTML = authoredSequence();
		const row = temporary.querySelector('li');
		list.append(row);
		bind(row);
		update();
	};
}

/** Bind independent sequences and the Program editor draft lifecycle. */
export function bindSequences(notify) {
	document.querySelectorAll('[data-sequence]').forEach(bindSequenceSection);
	document.querySelectorAll('[data-exclusions]').forEach(input => {
		const update = () => {
			input.closest('section').querySelector('[data-exclusion-strictness]').hidden = !input.value.trim(); 
		};
		input.addEventListener('input', update);
		update();
	});
	const form = document.querySelector('[data-program-editor]');
	if (!form) {
		return;
	}
	bindPreferences(form);
	form.querySelector('[data-program-usage]').onclick = event => {
		const open = event.currentTarget.getAttribute('aria-expanded') !== 'true';
		event.currentTarget.setAttribute('aria-expanded', String(open));
		form.querySelector('#program-reference-usage').hidden = !open;
	};
	const values = () => JSON.stringify({ fields: [...form.querySelectorAll('input,select,textarea')].map(input => [input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value]), ordering: form.querySelector('[data-detailed-choice][aria-pressed="true"]').dataset.detailedChoice });
	let saved = form.querySelector('.editor-body').cloneNode(true);
	let baseline = values();
	const save = form.querySelector('[data-program-save]');
	const reset = form.querySelector('[data-program-reset]');
	const update = () => {
		const dirty = values() !== baseline;
		reset.disabled = !dirty;
		save.disabled = dirty && !form.checkValidity();
		save.innerHTML = dirty ? `${actionIcon('save')}Save` : 'Close';
		save.classList.toggle('primary', dirty);
	};
	const close = () => {
		form.dispatchEvent(new CustomEvent('reference-dismiss', { bubbles: true, detail: { dirty: values() !== baseline, close: () => {
			window.location.href = '?layout=catalog'; 
		} } }));
	};
	form.addEventListener('input', update);
	form.addEventListener('change', update);
	form.querySelector('[data-program-close]').onclick = close;
	form.querySelector('[data-program-permanent-delete]').onclick = () => form.dispatchEvent(new CustomEvent('reference-delete', { bubbles: true }));
	save.onclick = () => {
		if (values() === baseline) {
			close();
		}
		else {
			baseline = values();
			saved = form.querySelector('.editor-body').cloneNode(true);
			update();
			notify('Program saved · prototype only');
		}
	};
	bindTwoStep(reset, () => {
		const body = saved.cloneNode(true);
		form.querySelector('.editor-body').replaceWith(body);
		body.querySelectorAll('[data-sequence]').forEach(bindSequenceSection);
		body.querySelectorAll('[data-language-bound]').forEach(section => section.removeAttribute('data-language-bound'));
		bindPreferences(body);
		update();
	});
	form.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
		}
	});
	update();
}

/** Content AI is a generation/review workflow, not a new Program type or automatic save. */
export function aiSourceSpecimen() {
	return `<section class="panel stack"><h3>Content · AI source</h3><label>Prompt<textarea rows="4" maxlength="2000">Find space exploration and first contact stories from this library.</textarea></label><label>Results<input type="range" min="50" max="250" step="50" value="100"><small>This is a target. Results can range from few to many across providers and models; review any modest overage before saving.</small></label><div class="row"><button type="button" class="primary">${actionIcon('sparkles')}Generate</button><button type="button">Review results</button></div><p class="small secondary">3 selected · 17 of 17 reviewed · 100%</p><div class="banner warning" role="status">This prompt has not been generated for the current selection. Save will keep the selected results.</div><div class="grid">${select('Order', ['Indexed date', 'Title', 'Release date'])}${select('Direction', ['Ascending', 'Descending'])}</div>${mediaCarousel('AI selection review')}</section>`;
}
