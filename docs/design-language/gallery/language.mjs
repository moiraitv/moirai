/* global document */

/** Small fictional-fixture language set; the application owns the complete language-name dataset. */
const languages = [['English', 'eng'], ['Spanish', 'spa'], ['French', 'fra'], ['German', 'deu'], ['Japanese', 'jpn']];

/** Mirror SubtitleLanguageCombobox's named lookup, code fallback and accessible list ownership. */
export function languageCombobox(id = 'specific-language') {
	return `<div class="language-reference stack tight" data-language-combobox><label for="${id}">Specific subtitle language</label><input id="${id}" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options" aria-describedby="${id}-help" placeholder="Search a language name or code"><div id="${id}-options" role="listbox" aria-label="Subtitle languages" hidden></div><small id="${id}-help" class="secondary">Names and equivalent codes match the same language. Your saved code is preserved.</small></div>`;
}

/** Exercise list keyboard navigation, selection, Escape and unknown-code fallback using local names. */
export function bindLanguages(root = document) {
	root.querySelectorAll('[data-language-combobox]:not([data-language-bound])').forEach(section => {
		section.dataset.languageBound = 'true';
		const input = section.querySelector('input');
		const list = section.querySelector('[role="listbox"]');
		let active = -1;
		const close = () => {
			list.hidden = true;
			input.setAttribute('aria-expanded', 'false');
			input.removeAttribute('aria-activedescendant');
		};
		const choose = button => {
			input.value = button.dataset.code;
			input.setAttribute('aria-invalid', 'false');
			input.dispatchEvent(new Event('input', { bubbles: true }));
			close();
		};
		const show = () => {
			const query = input.value.toLowerCase();
			list.innerHTML = languages.filter(([name, code]) => name.toLowerCase().includes(query) || code.includes(query)).map(([name, code], index) => `<button type="button" role="option" tabindex="-1" id="${input.id}-option-${index}" data-code="${code}" aria-selected="false">${name} (${code})</button>`).join('') || '<p>No named language matches. You can enter a two- or three-letter code.</p>';
			active = -1;
			list.hidden = false;
			input.setAttribute('aria-expanded', 'true');
			list.querySelectorAll('button').forEach(button => {
				button.onpointerdown = event => event.preventDefault();
				button.onclick = () => choose(button);
			});
		};
		input.addEventListener('focus', show);
		input.addEventListener('input', show);
		input.addEventListener('keydown', event => {
			const buttons = [...list.querySelectorAll('button')];
			if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
				event.preventDefault();
				if (list.hidden) {
					show();
				}
				active = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
				buttons.forEach((button, index) => button.setAttribute('aria-selected', String(index === active)));
				if (buttons[active]) {
					input.setAttribute('aria-activedescendant', buttons[active].id);
				}
			}
			if (event.key === 'Enter' && !list.hidden && buttons[active]) {
				event.preventDefault();
				choose(buttons[active]);
			}
			if (event.key === 'Escape' && !list.hidden) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		});
		input.addEventListener('blur', () => {
			input.setAttribute('aria-invalid', String(Boolean(input.value) && !/^[a-z]{2,3}$/i.test(input.value) && !languages.some(([name]) => name.toLowerCase() === input.value.toLowerCase())));
			close();
		});
	});
}
