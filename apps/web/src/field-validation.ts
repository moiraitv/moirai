import { computed, reactive, useId } from 'vue';

/** Structural subset of schema issues used to present field feedback without changing validation. */
interface FieldIssue {
	path: PropertyKey[];
	message: string;
	code: string;
	expected?: string;
	origin?: string;
	minimum?: number | bigint;
	maximum?: number | bigint;
	inclusive?: boolean;
}

/** Convert schema diagnostics into concise instructions for the edited field. */
function fieldMessage(issue: FieldIssue): string {
	if (issue.code === 'invalid_type') {
		return issue.expected === 'int' ? 'Enter a whole number.' : issue.expected === 'number' ? 'Enter a number.' : 'Enter a value.';
	}
	if (issue.code === 'too_small') {
		return issue.origin === 'string' ? issue.minimum === 1 ? 'Enter a value.' : `Use at least ${issue.minimum} characters.`
			: `Enter a number ${issue.inclusive ? 'at least' : 'greater than'} ${issue.minimum}.`;
	}
	if (issue.code === 'too_big') {
		return issue.origin === 'string' ? `Use no more than ${issue.maximum} characters.`
			: `Enter a number ${issue.inclusive ? 'no greater than' : 'less than'} ${issue.maximum}.`;
	}
	return issue.message;
}

/** Reveal schema errors on blur, then update them as the user corrects each touched field. */
export function useFieldValidation(validate: () => { success: boolean; error?: { issues: FieldIssue[] } }) {
	const prefix = useId();
	const touched = reactive(new Set<string>());
	const errors = computed(() => {
		const result: Record<string, string> = {};
		for (const issue of validate().error?.issues ?? []) {
			const path = issue.path.join('.');
			if (touched.has(path) && !result[path]) {
				result[path] = fieldMessage(issue);
			}
		}
		return result;
	});
	/** Identify the message owned by one field, including in nested editors. */
	function errorId(path: string): string {
		return `${prefix}-${path}-error`;
	}
	/** Return only errors the user has had an opportunity to address. */
	function error(path: string): string {
		return errors.value[path] ?? '';
	}
	/** Associate a control with its error while retaining any existing help description. */
	function attributes(path: string, helpId?: string) {
		return {
			'aria-invalid': error(path) ? 'true' as const : undefined,
			'aria-describedby': [helpId, error(path) ? errorId(path) : undefined].filter(Boolean).join(' ') || undefined,
			onBlur: () => touched.add(path),
		};
	}
	/** Clear interaction history when the owning draft is replaced or successfully saved. */
	function reset(): void {
		touched.clear();
	}
	return { error, errorId, attributes, reset, hasErrors: computed(() => Object.keys(errors.value).length > 0) };
}

/** Derive browser constraints from the same numeric contract used by Save validation. */
export function numericInputAttributes(schema: { minValue: number | null; maxValue: number | null; isInt: boolean; safeParse: (value: unknown) => { success: boolean } }) {
	const minimum = schema.minValue;
	return {
		min: minimum === null ? undefined : schema.isInt && !schema.safeParse(minimum).success ? minimum + 1 : minimum,
		max: schema.maxValue ?? undefined,
		step: schema.isInt ? 1 : 'any',
		inputmode: schema.isInt ? 'numeric' as const : 'decimal' as const,
	};
}
