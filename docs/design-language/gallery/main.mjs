/* global document, window */
import { families, layouts } from './manifest.mjs';
import { specimen } from './specimens.mjs';
import { pageLayout } from './pages.mjs';
import { bindInteractions } from './interactions.mjs';

/** The trusted family or layout selected by the URL; unknown IDs show the index. */
const params = new URL(window.location.href).searchParams;
/** Gallery component-family selection. */
const family = families.find(item => item.id === params.get('family'));
/** Full product composition selection. */
const layout = layouts.find(item => item.id === params.get('layout'));
/** Shared reference navigation, omitted from full-page composition captures. */
const referenceNav = '<nav class="reference-nav" aria-label="Design reference"><strong>Moirai / Design language</strong><a href="./">Contents</a><a href="./README.md">Handbook</a><a href="./docs/current-ui.md">Current UI mapping</a><a href="?concepts">Concept images</a><span class="pill">Current UI · radius trial</span></nav>';

if (layout) {
	document.title = `${layout.title} · Moirai reference`;
	document.querySelector('#app').innerHTML = pageLayout(layout.id);
}
else if (family) {
	document.title = `${family.title} · Moirai reference`;
	document.querySelector('#app').innerHTML = `${referenceNav}<main class="reference-main"><section class="board stack" data-board><header class="board-header"><div><span class="eyebrow">Moirai / ${family.title}</span><h2>${family.heading}</h2><p>${family.description}</p></div><span class="pill">Dark · initial edition</span></header>${specimen(family.id)}</section><p style="margin-top:var(--space-6)"><a href="./components/${family.id}.md">Read specifications →</a></p></main>`;
}
else if (params.has('concepts')) {
	document.querySelector('#app').innerHTML = `${referenceNav}<main class="reference-main stack"><h1>Historical exploratory concepts</h1><p class="secondary">Earlier AI-generated exploration, retained for history. Current source-backed layouts supersede these concepts. Written specifications and rendered specimens define the exact standard. These concepts contain illustrative features and copy that are not product requirements.</p>${['catalog-workspace', 'resource-editor', 'scheduling-workspace'].map(name => `<figure><img class="concept-image" src="./concepts/${name}.png" alt="Exploratory ${name.replaceAll('-', ' ')} concept"><figcaption><a href="./concepts/${name}.txt">Generation prompt</a></figcaption></figure>`).join('')}</main>`;
}
else {
	document.querySelector('#app').innerHTML = `${referenceNav}<main class="reference-main stack"><header class="reference-intro"><div><span class="eyebrow">Current UI · shared patterns</span><h1>Moirai, consistently.</h1><p>Current Moirai layouts and interactions, documented from their source owners. Shared styling is unified; the half-radius trial remains active.</p></div><div class="stack tight"><span class="pill success">${families.length} component families</span><span class="pill">${layouts.length} complete layouts</span><span class="pill">3 exploratory concepts</span></div></header><h2>Foundations & components</h2><div class="family-links">${families.map((item, index) => `<a class="panel" href="?family=${item.id}"><span class="eyebrow">${String(index + 1).padStart(2, '0')} / Reference</span><h3>${item.title}</h3><p>${item.description}</p></a>`).join('')}</div><h2>Complete compositions</h2><div class="family-links">${layouts.map(item => `<a class="panel" href="?layout=${item.id}"><h3>${item.title}</h3><p>${item.width} × ${item.height}</p></a>`).join('')}</div><p class="muted">Prototype only. Working demonstrations include protected editors, confirmations, selection segments, tooltips, contextual actions, native disclosures and toast dismissal. Other controls illustrate appearance and do not perform application operations.</p></main>`;
}

bindInteractions();
