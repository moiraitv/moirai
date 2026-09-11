import type { DefaultTheme } from 'vitepress';

/** Generated page status used to mark pending guide entries. */
interface ReviewPage {
	path: string;
	reviewStatus: string;
}

/** Decorate authored sidebar links using the same review manifest as the page banners. */
export function reviewSidebar(items: DefaultTheme.SidebarItem[], pages: ReviewPage[]): DefaultTheme.SidebarItem[] {
	const pending = new Set(pages.filter((page) => page.reviewStatus === 'needs-review').map((page) => page.path));
	return items.map((item) => ({
		...item,
		...(item.link && pending.has(item.link === '/' ? '/help/' : `/help${item.link}.html`) ? {
			text: `${item.text ?? ''} <span class="docs-menu-review-badge" aria-label="Needs review" title="Needs review">Review</span>`,
		} : {}),
		...(item.items ? { items: reviewSidebar(item.items, pages) } : {}),
	}));
}
