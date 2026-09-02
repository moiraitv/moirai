import { describe, expect, it, vi } from 'vitest';
import { useAnimatedDismissal } from '@web/motion.js';

describe('animated dismissal', () => {
	it('keeps ownership active until the leave transition reports completion', () => {
		const closed = vi.fn();
		const dismissal = useAnimatedDismissal(closed);

		expect(dismissal.visible.value).toBe(true);
		dismissal.requestClose();
		expect(dismissal.visible.value).toBe(false);
		expect(closed).not.toHaveBeenCalled();

		dismissal.finishClose();
		expect(closed).toHaveBeenCalledOnce();
	});

	it('treats repeated dismissal gestures as the same pending close', () => {
		const closed = vi.fn();
		const dismissal = useAnimatedDismissal(closed);

		dismissal.requestClose();
		dismissal.requestClose();

		expect(dismissal.visible.value).toBe(false);
		expect(closed).not.toHaveBeenCalled();
	});
});
