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
