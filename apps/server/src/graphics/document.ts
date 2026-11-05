import { graphicsDocumentSchema, type GraphicsDocument } from '@moirai/shared';
import { isAlias, LineCounter, parseDocument, visit } from 'yaml';

/** Parse one bounded YAML document, keeping YAML diagnostics in editor coordinates. */
export function parseGraphics(source: string): GraphicsDocument {
	if (source.length > 32_768) {
		throw new Error('Graphics YAML exceeds 32 KiB');
	}
	const lineCounter = new LineCounter();
	const document = parseDocument(source, { lineCounter });
	const issue = document.errors[0] ?? document.warnings[0];
	if (issue) {
		throw new Error(issue.message);
	}
	visit(document, (_key, node, path) => {
		if (isAlias(node) || (node && typeof node === 'object' && 'tag' in node && node.tag) || path.length > 24) {
			throw new Error('Graphics YAML allows neither aliases nor explicit tags, and limits nesting to 24 levels');
		}
	});
	const result = graphicsDocumentSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
	if (!result.success) {
		const first = result.error.issues[0]!;
		const node = document.getIn(first.path, true);
		const line = node && typeof node === 'object' && 'range' in node && Array.isArray(node.range)
			? lineCounter.linePos(node.range[0]).line
			: 1;
		throw new Error(`Line ${line}, ${first.path.join('.') || 'document'}: ${first.message}`);
	}
	return result.data;
}
