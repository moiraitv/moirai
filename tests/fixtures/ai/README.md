# AI selection evaluation

The JSON suite contains draft editorial labels for broad genres, exclusions, empty selections,
nuanced movie features and episode-specific features. Sparse summaries intentionally omit some
qualifying details. Review the labels for your intended interpretation before treating scores as a
quality gate. The small sample does not measure large-library retrieval recall; add representative
library identities and expected IDs for that comparison.

The baseline prompt is frozen from the earlier title/year implementation. Both variants use the same
configured provider/model and web-search setting. Baseline uses its old alphabetical 8,000-row/128 KiB
limit and five-call budget; the new pipeline uses search-free discovery and review, then up to sixteen verification calls. Results
report selection precision/recall, candidate recall, durations, model requests, and reported usage.
Missing provider usage is not an estimate of zero cost. Repeat cases to assess model variability.

The runner is opt-in and makes paid requests only with `--run`:

```bash
node --env-file=.env --import tsx scripts/evaluate-ai.ts --run
# Or pass a larger, reviewed suite with the same JSON shape:
node --env-file=.env --import tsx scripts/evaluate-ai.ts --run /path/to/suite.json
```

It uses the already packaged model at `apps/server/dist/embedding-model` with downloads disabled,
and computes fixture embeddings in memory. It does not open or modify the production database.
Without `--run`, it prints usage and performs no inference or paid requests. The runner stops on a
failed request rather than retrying or counting incomplete results as valid selections.

## Compare models on a development library

`npm run ai:compare -- --list-libraries` prints library IDs from the configured development database. Keep a copy of `scripts/compare-ai-models.example.json` in `~/Projects/moirai-tests/`, replace `libraryId`, and edit the prompt and `models` array. Every model entry must supply `apiKey`, `baseUrl`, `model`, and `webSearch`; `name` is an optional report label. An `apiKey` value such as `env:OPENROUTER_API_KEY` reads the key from the environment or the ignored root `.env` file. Keep raw keys out of tracked files.

For an endpoint that rejects Chat Completions `response_format: {"type":"json_object"}`, set `"chatJsonMode": "prompt_only"` on that model. The runner omits the field in both the small provider check and full selection requests; it still instructs the model to return JSON and validates each response. Anthropic's direct compatibility endpoint currently needs this setting. This comparison setting does not change the server's provider configuration.

```bash
cp -n scripts/compare-ai-models.example.json ~/Projects/moirai-tests/compare-ai-models.json
npm run ai:compare -- --run ~/Projects/moirai-tests/compare-ai-models.json --output ~/Projects/moirai-tests/ai-comparison.json
```

Use `--diagnose` with `--run` for a slow-provider investigation. It gives each model up to 15 minutes and creates a private, timestamped `ai-diagnostics-*` directory beside the configuration. Each provider request is saved before sending, followed by its raw response or transport error, with phase and timing. The files include the prompt and library candidate rows, but omit authorization headers and redact configured API keys. Each model's result is saved immediately; the existing comparison report is left untouched. This mode makes the same preflight checks and does not retry paid requests.

Use `--evaluate` for a bounded comparison of the five configured models. It checks credentials first, tests provider-specific reasoning settings with capped output, excludes Venice for Qwen on OpenRouter, and uses the production five-minute non-search deadline with two concurrent 125-candidate review batches at a time plus a final quality pass. Slow planning models use local prompt concepts. Native Claude Messages with structured output is selected for the direct Anthropic endpoint or with optional `apiProtocol: "anthropic-messages"`; the four existing settings remain required. The runner repeats models whose first full run completes. A private `ai-evaluation-v2-budget.json` beside the configuration retains conservative reservations across pilot and full invocations and stops dispatching at a new aggregate $10 allowance; `--max-spend` also limits a single invocation. Reported estimated cost is a reservation, not an invoice. Private captures include per-request phase timing, HTTP status, provider when reported, and usage. No ambiguous paid request is retried. The production path does not apply the evaluation runner's model-specific tuning or its dollar cap.

```bash
npm run ai:compare -- --run ~/Projects/moirai-tests/compare-ai-models.json --evaluate
# A one-batch pilot before full comparison:
npm run ai:compare -- --run ~/Projects/moirai-tests/compare-ai-models.json --evaluate --pilot --only qwen/qwen3.5-397b-a17b,grok-4.7,claude-sonnet-5 --max-spend 2
```

Use `--only` with comma-separated model IDs to investigate failed models without repeating the whole suite. Use `--max-spend` to reduce the run's allowance below $10; track prior run reservations when evaluating an aggregate budget across several invocations.

```bash
npm run ai:compare -- --run ~/Projects/moirai-tests/compare-ai-models.json --diagnose
```

The runner opens the configured development SQLite database read-only. Set `databasePath` in the JSON file to choose another database; relative paths resolve beside that file. Before full generation, it checks the report path, library, cached media vectors, local embedding model, and every configured provider with a small bounded request. If any provider check fails, no full selection runs; the terminal shows only safe status codes and generic connection errors, not provider response bodies or keys. These preliminary requests may incur small API charges. It then runs the production selection pipeline sequentially for each model using the same prompt and result ceiling. The packaged local embedding model prepares each model's query concepts in memory; build the server first if `apps/server/dist/embedding-model` is absent. The report contains counts, durations, model request and reported usage totals, selected titles, and pairwise overlap. It stores a prompt hash rather than the prompt and never writes keys to the report. Overlap and count are not quality scores; review the selected titles against the prompt. Missing media embeddings can reduce match quality, and provider search usage may not be comparable unless the endpoint reports calls in the format Moirai currently counts. Each `--run` may incur API charges; without it, the command only prints usage.
