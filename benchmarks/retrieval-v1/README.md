# retrieval-v1 (1.0.0)

Support-doc retrieval over 8 queries against fixed relevant-id sets.
Subjects emit `{"retrieved_ids": [...]}`. Overlapping relevance sets
deliberately punish static (query-independent) retrieval.

- Population: 8 queries, one small id universe. Tests retrieval signal, not scale.
- Gate: `retrieval_recall >= 0.75`.

```bash
genesis run-benchmark retrieval-v1 --subject "python ./retriever.py {task_file}" --out ./results/ret
```

## Version history

- 1.0.0 — initial 8-query population.
