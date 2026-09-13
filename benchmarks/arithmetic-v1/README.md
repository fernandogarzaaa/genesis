# arithmetic-v1 (1.0.0)

Deterministic smoke benchmark: double 8 fixed integers, scored by exact
match. Intended as the "hello world" teams run first — it validates the
Genesis loop (dataset → subject → evaluator → verdict) in seconds.

- Population: 8 fixed cases, in-distribution only. Says nothing about
  generalization, robustness, or any non-doubling task.
- Evaluator: `exact`. Brittle by design (see assurance: case/whitespace
  variants fail); use it to learn the workflow, not to grade fuzzy systems.
- Gate: `task_success >= 0.875` with 2 repetitions.

Run your system against it:

```bash
genesis run-benchmark arithmetic-v1 --subject "python ./agent.py {task_file}" --out ./results/arith
```

## Version history

- 1.0.0 — initial 8-case population.
