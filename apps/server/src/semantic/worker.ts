import { budgetSemanticText } from './token-budget.js';
import { env, pipeline } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.useFSCache = false;
const extractor = await pipeline('feature-extraction', process.argv[2], {
	device: 'cpu', dtype: 'fp32', local_files_only: true,
	session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
});
process.on('disconnect', () => process.exit(0));
process.on('message', async (input: string | { text: string; media: boolean }) => {
	try {
		const text = typeof input === 'string' ? input : input.media ? budgetSemanticText(input.text, extractor.tokenizer) : input.text;
		const result = await extractor(text, { pooling: 'cls', normalize: true });
		process.send!({ vector: Array.from(result.data) });
	}
	catch {
		process.send!({ error: 'inference-failed' });
	}
});
