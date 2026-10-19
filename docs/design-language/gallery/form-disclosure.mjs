import { actionIcon } from './fixtures.mjs';

/** Preserve the application's icon, title, description and chevron disclosure anatomy. */
export function disclosure(title, description, glyph, content, open = false) {
	return `<details class="reference-form-disclosure" ${open ? 'open' : ''}><summary><span class="reference-disclosure-icon">${actionIcon(glyph)}</span><span class="reference-disclosure-copy"><strong>${title}</strong><small>${description}</small></span>${actionIcon('chevron-down')}</summary><div class="reference-disclosure-content">${content}</div></details>`;
}
