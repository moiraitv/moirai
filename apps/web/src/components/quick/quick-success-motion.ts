/** Animate only the dialog surface between measured bounds, keeping success text unscaled. */
export function animateQuickSuccess(element: HTMLElement, previous: DOMRect): void {
	if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
		return;
	}
	const current = element.getBoundingClientRect();
	const surface = document.createElement('div');
	surface.className = 'quick-success-morph';
	surface.setAttribute('aria-hidden', 'true');
	Object.assign(surface.style, {
		left: `${current.left}px`, top: `${current.top}px`,
		width: `${current.width}px`, height: `${current.height}px`,
	});
	element.parentElement?.append(surface);
	const timing = { duration: 350, easing: 'ease-in-out' };
	const animation = surface.animate([
		{ transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px) scale(${previous.width / current.width}, ${previous.height / current.height})`, opacity: 1 },
		{ transform: 'none', opacity: 0 },
	], timing);
	element.animate([{ opacity: 0 }, { opacity: 1 }], timing);
	void animation.finished.catch(() => undefined).finally(() => surface.remove());
}
