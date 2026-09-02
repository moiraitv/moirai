import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSelectionToolbarTransition } from '@web/selection-toolbar-transition';

describe('selection toolbar transition', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('settles layout before revealing and removes layout only after fading', async () => {
		const frames = new Map<number, FrameRequestCallback>();
		let frameId = 0;
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frameId += 1;
			frames.set(frameId, callback);
			return frameId;
		});
		vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
		const transition = useSelectionToolbarTransition();

		transition.show();
		expect(transition.active.value).toBe(true);
		expect(transition.mounted.value).toBe(true);
		expect(transition.revealed.value).toBe(false);
		await nextTick();
		frames.get(1)?.(0);
		frames.get(2)?.(16);
		expect(transition.revealed.value).toBe(true);

		transition.hide();
		expect(transition.active.value).toBe(false);
		expect(transition.mounted.value).toBe(true);
		expect(transition.revealed.value).toBe(false);
		const target = new EventTarget();
		transition.finish({ target, currentTarget: target, propertyName: 'opacity' });
		expect(transition.mounted.value).toBe(false);
	});

	it('removes an unrevealed toolbar immediately when opening is cancelled', async () => {
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			frames.set(1, callback);
			return 1;
		});
		vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
		const transition = useSelectionToolbarTransition();

		transition.show();
		await nextTick();
		transition.hide();

		expect(transition.active.value).toBe(false);
		expect(transition.mounted.value).toBe(false);
		expect(frames.size).toBe(0);
	});
});
