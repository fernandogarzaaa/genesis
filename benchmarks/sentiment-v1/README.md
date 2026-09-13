# sentiment-v1 (1.0.0)

Binary review-sentiment classification over 8 short reviews. Subjects should
emit a label plus a confidence score (`{"label": ..., "score": ...}`) so the
benchmark can gate accuracy, ranking (ROC-AUC), and calibration (ECE) — a
100%-accurate but overconfident system fails the calibration gate on purpose.

- Population: 8 hand-written reviews. Toy scale; validates pipelines, not models.
- Positive class: `positive`. Scores in [0,1] required for AUC/calibration.
- Gates: `accuracy >= 0.75`, `calibration_ece <= 0.2`.

```bash
genesis run-benchmark sentiment-v1 --subject "python ./classifier.py {task_file}" --out ./results/sent
```

## Version history

- 1.0.0 — initial 8-review population.
