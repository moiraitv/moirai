/** Hide an image whose source could not be displayed. */
export function hideBrokenImage(event: Event): void {
	(event.currentTarget as HTMLImageElement).hidden = true;
}
