import { graphicsDocumentSchema } from '@moirai/shared';
import { isAlias, isMap, LineCounter, parseDocument, visit, type Document } from 'yaml';

/** Parse the editor draft without expanding aliases or accepting custom tags. */
export function readGraphicsDraft(source: string) {
	try {
		if (source.length > 32_768) {
			throw new Error('Graphics YAML exceeds 32 KiB');
		}
		const lines = new LineCounter();
		const yaml = parseDocument(source, { lineCounter: lines });
		const issue = yaml.errors[0] ?? yaml.warnings[0];
		if (issue) {
			throw new Error(issue.message);
		}
		visit(yaml, (_key, node, path) => {
			if (isAlias(node) || (node && typeof node === 'object' && 'tag' in node && node.tag) || path.length > 24) {
				throw new Error('YAML aliases, explicit tags, and nesting beyond 24 levels are disabled');
			}
		});
		const result = graphicsDocumentSchema.safeParse(yaml.toJS({ maxAliasCount: 0 }));
		if (!result.success) {
			const first = result.error.issues[0]!;
			const node = yaml.getIn(first.path, true);
			const line = node && typeof node === 'object' && 'range' in node && Array.isArray(node.range)
				? lines.linePos(node.range[0]).line
				: 1;
			throw new Error(`Line ${line}, ${first.path.join('.') || 'document'}: ${first.message}`);
		}
		return { data: result.data, yaml, error: '' } as const;
	}
	catch (cause) {
		return { data: null, yaml: null, error: (cause as Error).message } as const;
	}
}

/** Update only changed YAML nodes, retaining comments on neighboring style and timing fields. */
export function patchGraphicsYaml(yaml: Document, path: (string | number)[], value: unknown): void {
	if (value === undefined) {
		yaml.deleteIn(path);
		return;
	}
	const node = yaml.getIn(path, true);
	if (isMap(node) && value && typeof value === 'object' && !Array.isArray(value)) {
		const fields = value as Record<string, unknown>;
		for (const pair of [...node.items]) {
			const key = String(pair.key);
			if (!Object.hasOwn(fields, key)) {
				yaml.deleteIn([...path, key]);
			}
		}
		for (const [key, child] of Object.entries(fields)) {
			patchGraphicsYaml(yaml, [...path, key], child);
		}
		return;
	}
	if (yaml.getIn(path) !== value) {
		yaml.setIn(path, value);
	}
}
