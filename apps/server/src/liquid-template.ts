import { Liquid, type LiquidOptions } from 'liquidjs';

/** Configure a bounded Liquid runtime over plain data with filesystem tags disabled. */
export function createBoundedLiquid(options: Pick<LiquidOptions, 'parseLimit' | 'renderLimit' | 'memoryLimit' | 'outputEscape' | 'strictVariables'>): Liquid {
	const engine = new Liquid({ strictFilters: true, lenientIf: true, ownPropertyOnly: true, ...options });
	for (const tag of ['include', 'render', 'layout']) {
		engine.registerTag(tag, {
			parse() {
				throw new Error('File-loading template tags are disabled');
			},
			render() {
				return '';
			},
		});
	}
	return engine;
}
