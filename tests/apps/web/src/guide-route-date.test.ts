import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, reactive } from 'vue';
import { useGuideRouteDate } from '@web/composables/useGuideRouteDate.js';

const routing = vi.hoisted(() => ({
	route: { query: { startDate: '2026-01-16' } },
	replace: vi.fn().mockResolvedValue(undefined),
	push: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('vue-router', () => ({
	useRoute: () => routing.route,
	useRouter: () => routing,
}));
let scope: ReturnType<typeof effectScope>;

beforeEach(() => {
	routing.route = reactive({ query: { startDate: '2026-01-16' } });
	vi.clearAllMocks();
	scope = effectScope();
});
afterEach(() => scope.stop());

it('does not reconcile or restart reads after its owning page is disposed', async () => {
	const state = { timeZone: 'UTC', guideWeekStart: '2026-01-17' };
	const refresh = vi.fn().mockResolvedValue(undefined);
	let guide!: ReturnType<typeof useGuideRouteDate>;
	scope.run(() => {
		guide = useGuideRouteDate(state, refresh, vi.fn());
	});
	let finish!: () => void;
	const gate = new Promise<void>(resolve => {
		finish = resolve;
	});
	const pending = guide.load(() => gate);
	scope.stop();
	finish();
	expect(await pending).toBe(false);
	guide.activate();
	expect(refresh).not.toHaveBeenCalled();
	expect(routing.replace).not.toHaveBeenCalled();
});

for (const destination of ['2026-01-16', '2026-01-18']) {
	it(`supersedes a pending history read when navigating to ${destination}`, async () => {
		const state = { timeZone: 'UTC', guideWeekStart: '2026-01-16' };
		const reads: Array<{ finish: () => void; result: Promise<boolean> }> = [];
		const onError = vi.fn();
		let guide!: ReturnType<typeof useGuideRouteDate>;
		const refresh = vi.fn(() => {
			let finish!: () => void;
			const gate = new Promise<void>(resolve => {
				finish = resolve;
			});
			const result = guide.load(() => gate);
			reads.push({ finish, result });
			return result.then(() => undefined);
		});
		scope.run(() => {
			guide = useGuideRouteDate(state, refresh, onError);
		});
		guide.activate();

		routing.route.query.startDate = '2026-01-17';
		await nextTick();
		routing.route.query.startDate = destination;
		await nextTick();
		expect(refresh).toHaveBeenCalledTimes(2);

		// The store ignores the superseded response; its continuation must also be ignored.
		reads[0]!.finish();
		expect(await reads[0]!.result).toBe(false);
		expect(routing.replace).not.toHaveBeenCalled();
		expect(routing.route.query.startDate).toBe(destination);

		// Only the latest read may normalize a committed window back into the URL.
		state.guideWeekStart = '2026-01-19';
		reads[1]!.finish();
		expect(await reads[1]!.result).toBe(true);
		expect(routing.replace).toHaveBeenCalledExactlyOnceWith({ query: { startDate: '2026-01-19' } });
		expect(onError).not.toHaveBeenCalled();
	});
}
