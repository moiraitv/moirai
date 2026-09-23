import type { Component } from 'vue';
import type { ProgramConfig } from '@moirai/shared';
import ContentProgramDetails from './ContentProgramDetails.vue';
import SemanticProgramDetails from './SemanticProgramDetails.vue';
import SequenceProgramDetails from './SequenceProgramDetails.vue';

/** Type-specific inspection stays outside the shared layout and navigation shell. */
const detailComponents: Record<ProgramConfig['type'], Component> = {
	content: ContentProgramDetails,
	similarity: SemanticProgramDetails,
	theme: SemanticProgramDetails,
	sequence: SequenceProgramDetails,
};
/** Resolve supported detail UI while retaining a neutral future-type fallback. */
export function programDetailComponent(type: string): Component | undefined {
	return detailComponents[type as ProgramConfig['type']];
}
