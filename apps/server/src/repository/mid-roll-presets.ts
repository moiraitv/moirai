import type { MidRollPreset, MidRollPresetCreate, MidRollSettings } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { FillerPresetRepository } from './filler-presets.js';
export { FillerPresetError as MidRollPresetError } from './filler-presets.js';

/** Preserve the Mid-Roll administration interface over shared filler storage. */
export class MidRollPresetRepository {
	private readonly presets: FillerPresetRepository;
	constructor(db: MoiraiDatabase) {
		this.presets = new FillerPresetRepository(db);
	}
	/** List only Mid-Rolls through the compatibility endpoint. */
	async list(): Promise<MidRollPreset[]> {
		return this.presets.list('mid-roll') as Promise<MidRollPreset[]>;
	}
	/** Load the requested reusable break settings together. */
	settings(ids: string[]): Record<string, MidRollSettings> {
		return this.presets.settings(ids) as Record<string, MidRollSettings>;
	}
	/** Save a Mid-Roll without permitting its stage to change. */
	async save(input: MidRollPresetCreate, id?: string): Promise<{ preset: MidRollPreset; behaviorChanged: boolean }> {
		const result = await this.presets.save({ ...input, kind: 'mid-roll' }, id);
		return { ...result, preset: result.preset as MidRollPreset };
	}
	/** Delete an unused custom Mid-Roll. */
	async delete(id: string): Promise<void> {
		await this.presets.delete(id, 'mid-roll');
	}
}
