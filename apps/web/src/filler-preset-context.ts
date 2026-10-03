import type { InjectionKey, Ref } from 'vue';
import type { AnyFillerPreset } from '@moirai/shared';

/** Share one loaded catalog across the visual and its selected assignment controls. */
export const fillerPresetContext: InjectionKey<Ref<AnyFillerPreset[]>> = Symbol('filler-presets');
