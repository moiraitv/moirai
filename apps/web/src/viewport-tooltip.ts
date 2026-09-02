/** Screen geometry needed to place one fixed tooltip. */
export interface ViewportTooltipGeometry {
	anchor: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'height'>;
	tooltipWidth: number;
	tooltipHeight: number;
	viewportWidth: number;
	viewportHeight: number;
}

/** Fixed viewport coordinates for one tooltip. */
export interface ViewportTooltipPosition {
	left: number;
	top: number;
}

/** Place a tooltip beside its trigger, flip horizontally, and clamp it inside the viewport. */
export function viewportTooltipPosition(
	geometry: ViewportTooltipGeometry,
): ViewportTooltipPosition {
	const margin = 12;
	const gap = 12;
	const { anchor, tooltipWidth, tooltipHeight, viewportWidth, viewportHeight } = geometry;
	const fitsRight = anchor.right + gap + tooltipWidth <= viewportWidth - margin;
	const preferredLeft = fitsRight
		? anchor.right + gap
		: anchor.left - gap - tooltipWidth;
	const maximumLeft = Math.max(margin, viewportWidth - tooltipWidth - margin);
	const left = Math.min(Math.max(margin, preferredLeft), maximumLeft);
	const centeredTop = anchor.top + anchor.height / 2 - tooltipHeight / 2;
	const maximumTop = Math.max(margin, viewportHeight - tooltipHeight - margin);
	const top = Math.min(Math.max(margin, centeredTop), maximumTop);
	return { left, top };
}
