/** Capture the rendered positions of the form sections surrounding the disclosure. */
export function captureDisclosureLayout(root: HTMLElement): Map<HTMLElement, DOMRect> {
	const sections = root.closest('.resource-editor-scroll')?.children ?? [];
	return new Map(Array.from(sections).filter((element): element is HTMLElement =>
		element instanceof HTMLElement && !element.contains(root)).map((element) => [element, element.getBoundingClientRect()]));
}

/** Animate one committed layout with transforms, keeping measurements out of animation frames. */
export function animateDisclosureLayout(before: Map<HTMLElement, DOMRect>, timing: KeyframeAnimationOptions): Animation[] {
	const offsets = [...before].map(([element, rect]) => ({ element, offset: rect.top - element.getBoundingClientRect().top }));
	return offsets.filter(({ offset }) => Math.abs(offset) > .5).map(({ element, offset }) =>
		element.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], timing));
}
