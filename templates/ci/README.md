# Genesis CI regression template

Gates releases on a versioned benchmark: runs the benchmark against the
candidate, then fails the build if quality/latency/cost regress beyond the
allowed thresholds relative to the checked-in baseline bundle.

## Setup (5 minutes)

1. Copy `genesis-regression.yml` into your repository's `.github/workflows/`.
2. Set `BENCHMARK` (registry name) and `SUBJECT_CMD` (how CI invokes the
   system under test) in the workflow env.
3. Record the baseline once from a known-good revision:

```bash
genesis run-benchmark sentiment-v1 \
  --subject "python ./classifier.py {task_file}" \
  --out ./results/baseline
git add results/baseline
git commit -m "chore: record evaluation baseline"
```

4. Every later run compares `./results/current` against `./results/baseline`
   and fails on regression (default: quality drop > 0.02).

To refresh the baseline intentionally (new model, new data), re-record from
main and commit the new bundle — the evidence bundle is the audit trail, so
baseline updates stay reviewable diffs.

## Thresholds

Defaults live in the workflow env (`MAX_QUALITY_DROP`, `MAX_LATENCY_INCREASE`).
For benchmark-specific gates, point the regression step at the benchmark spec:

```bash
genesis regression --base ./results/baseline --candidate ./results/current \
  --config ./benchmarks/sentiment-v1/benchmark.yaml
```

`--config` reads the spec's `regression:` block when present; otherwise the
defaults above apply.
