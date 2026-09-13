/**
 * Metrics engine: composable, pluggable measurements over trials.
 *
 * Built-ins cover quality, reliability, performance, cost, agent, retrieval,
 * classification families. Custom metrics register via `registerMetric`.
 * Metrics never throw on missing data — they return null (→ INCONCLUSIVE).
 */

import type { Observation, Trial } from "./types.js";

export type MetricInput = {
  readonly trials: readonly Trial[];
  readonly observations: readonly Observation[];
};

export type MetricFn = (input: MetricInput) => number | null;

const registry = new Map<string, { fn: MetricFn; unit?: string; description: string }>();

function reg(name: string, description: string, fn: MetricFn, unit?: string): void {
  registry.set(name, { fn, description, ...(unit ? { unit } : {}) });
}

export function registerMetric(name: string, description: string, fn: MetricFn, unit?: string): void {
  if (registry.has(name)) throw new Error(`metric "${name}" already registered`);
  reg(name, description, fn, unit);
}

export function metricNames(): string[] {
  return [...registry.keys()].sort();
}

export function computeMetric(name: string, input: MetricInput): { value: number | null; unit?: string } {
  const m = registry.get(name);
  if (!m) {
    // Parameterized: detail:<field> averages a numeric observation.details field
    // (e.g. detail:faithfulness for LLM-judge structured outputs).
    const dm = name.match(/^detail:([\w.-]+)$/);
    if (dm) {
      const field = dm[1] as string;
      const vals = input.observations
        .map((o) => (o.details as Record<string, unknown> | undefined)?.[field])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      return { value: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    }
    throw new Error(`unknown metric "${name}" (available: ${metricNames().join(", ")}, or detail:<field>)`);
  }
  return { value: m.fn(input), ...(m.unit ? { unit: m.unit } : {}) };
}

function scores(input: MetricInput): number[] {
  return input.observations.map((o) => o.score).filter((s): s is number => typeof s === "number");
}

function passRate(input: MetricInput): number | null {
  const decided = input.observations.map((o) => o.passed).filter((p): p is boolean => typeof p === "boolean");
  if (decided.length === 0) return null;
  return decided.filter(Boolean).length / decided.length;
}

function latencies(input: MetricInput): number[] {
  return input.trials.map((t) => t.duration_ms);
}

// ── quality ──
reg("task_success", "fraction of trials with passed=true", (i) => passRate(i));
reg("accuracy", "fraction of trials with passed=true (alias of task_success)", (i) => passRate(i));
reg("mean_score", "mean of numeric scores", (i) => {
  const s = scores(i);
  return s.length > 0 ? s.reduce((a, b) => a + b, 0) / s.length : null;
});
reg("exact_match", "fraction with score==1", (i) => {
  const s = scores(i);
  return s.length > 0 ? s.filter((v) => v === 1).length / s.length : null;
});
reg("failure_rate", "1 - task_success", (i) => {
  const p = passRate(i);
  return p === null ? null : 1 - p;
});

// ── reliability ──
reg("timeout_rate", "fraction of trials that timed out", (i) =>
  i.trials.length > 0 ? i.trials.filter((t) => t.timed_out).length / i.trials.length : null,
);
reg("error_rate", "fraction of trials with error", (i) =>
  i.trials.length > 0 ? i.trials.filter((t) => t.error !== null).length / i.trials.length : null,
);
reg("success_rate", "fraction of trials without error/timeout", (i) =>
  i.trials.length > 0 ? i.trials.filter((t) => !t.timed_out && t.error === null).length / i.trials.length : null,
);

// ── performance ──
reg("mean_latency_ms", "mean trial duration", (i) =>
  i.trials.length > 0 ? i.trials.reduce((a, t) => a + t.duration_ms, 0) / i.trials.length : null, "ms",
);
reg("p50_latency_ms", "median trial duration", (i) => percentile(latencies(i), 50), "ms");
reg("p95_latency_ms", "p95 trial duration", (i) => percentile(latencies(i), 95), "ms");
reg("p99_latency_ms", "p99 trial duration", (i) => percentile(latencies(i), 99), "ms");
reg("throughput_per_min", "trials per minute of wall time", (i) => {
  if (i.trials.length === 0) return null;
  const total = i.trials.reduce((a, t) => a + t.duration_ms, 0);
  return total <= 0 ? null : (i.trials.length / total) * 60000;
});

// ── cost ──
reg("total_cost_usd", "sum of estimated USD", (i) => {
  const costs = i.trials.map((t) => t.cost?.estimated_usd).filter((c): c is number => typeof c === "number");
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;
}, "usd");
reg("mean_cost_usd", "mean estimated USD per trial", (i) => {
  const costs = i.trials.map((t) => t.cost?.estimated_usd).filter((c): c is number => typeof c === "number");
  return costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
}, "usd");
reg("cost_per_success_usd", "total cost / successful trials", (i) => {
  const costs = i.trials.map((t) => t.cost?.estimated_usd).filter((c): c is number => typeof c === "number");
  const succ = i.observations.filter((o) => o.passed === true).length;
  if (costs.length === 0 || succ === 0) return null;
  return costs.reduce((a, b) => a + b, 0) / succ;
}, "usd");
reg("total_tokens", "sum of tokens", (i) => {
  const toks = i.trials.map((t) => t.cost?.total_tokens).filter((c): c is number => typeof c === "number");
  return toks.length > 0 ? toks.reduce((a, b) => a + b, 0) : null;
});

// ── agent-specific (derived from trial/observation metadata where present) ──
reg("mean_steps", "mean steps (trial metadata steps)", (i) => {
  const steps = i.trials
    .map((t) => (t.output && typeof t.output === "object" ? (t.output as Record<string, unknown>).steps : null))
    .filter((s): s is number => typeof s === "number");
  return steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : null;
});

// ── classification (binary, from predicted_bool/actual_bool pairs) ──
//
// Pairs are recorded by the `classification` evaluator. Binary-only metrics
// return null when no boolean pairs exist (e.g. multiclass tasks with no
// declared positive class) instead of silently degrading to accuracy.

function classPairs(input: MetricInput): { predicted: boolean; actual: boolean }[] {
  const out: { predicted: boolean; actual: boolean }[] = [];
  for (const o of input.observations) {
    const d = o.details as Record<string, unknown> | undefined;
    if (d && typeof d.predicted_bool === "boolean" && typeof d.actual_bool === "boolean") {
      out.push({ predicted: d.predicted_bool as boolean, actual: d.actual_bool as boolean });
    }
  }
  return out;
}

function scorePairs(input: MetricInput): { score: number; actual: boolean }[] {
  const out: { score: number; actual: boolean }[] = [];
  for (const o of input.observations) {
    const d = o.details as Record<string, unknown> | undefined;
    if (d && typeof d.score === "number" && Number.isFinite(d.score) && typeof d.actual_bool === "boolean") {
      out.push({ score: d.score as number, actual: d.actual_bool as boolean });
    }
  }
  return out;
}

reg("precision", "TP/(TP+FP) over boolean pairs; null without a positive class", (i) => classificationMetrics(classPairs(i)).precision);
reg("recall", "TP/(TP+FN) over boolean pairs; null without a positive class", (i) => classificationMetrics(classPairs(i)).recall);
reg("f1", "harmonic mean of precision/recall; null without a positive class", (i) => classificationMetrics(classPairs(i)).f1);
reg("roc_auc", "Mann-Whitney ROC-AUC over (score, actual) pairs; null without scores or single-class data", (i) => rocAuc(scorePairs(i)));
reg("pr_auc", "average-precision PR-AUC over (score, actual) pairs; null without scores", (i) => prAuc(scorePairs(i)));
reg("calibration_ece", "expected calibration error (10 bins, lower is better); null without scores", (i) => expectedCalibrationError(scorePairs(i)));

// ── retrieval / RAG ──
//
// Per-trial precision/recall from details {retrieved_ids, relevant_ids}
// (recorded by the `retrieval` evaluator), averaged over defined trials.
// Undefined trials (no retrieved or no relevant docs) are excluded, not zeroed.

function retrievalPRs(input: MetricInput): { p: number | null; r: number | null }[] {
  const out: { p: number | null; r: number | null }[] = [];
  for (const o of input.observations) {
    const d = o.details as Record<string, unknown> | undefined;
    if (!d || !Array.isArray(d.retrieved_ids) || !Array.isArray(d.relevant_ids)) continue;
    const retrieved = (d.retrieved_ids as unknown[]).map(String);
    const relevant = new Set((d.relevant_ids as unknown[]).map(String));
    const hits = retrieved.filter((id) => relevant.has(id)).length;
    out.push({
      p: retrieved.length === 0 ? null : hits / retrieved.length,
      r: relevant.size === 0 ? null : hits / relevant.size,
    });
  }
  return out;
}

function meanDefined(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** F1 from defined precision/recall; 0 when both defined but disjoint, null when undefined. */
export function retrievalF1(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  if (p + r <= 0) return 0;
  return (2 * p * r) / (p + r);
}

/** Per-trial retrieval values for statistics (defined trials only). */
export function trialRetrievalValues(
  observations: readonly { details?: Record<string, unknown> }[],
  which: "p" | "r" | "f1",
): number[] {
  const out: number[] = [];
  for (const o of observations) {
    const d = o.details;
    if (!d || !Array.isArray(d.retrieved_ids) || !Array.isArray(d.relevant_ids)) continue;
    const retrieved = (d.retrieved_ids as unknown[]).map(String);
    const relevant = new Set((d.relevant_ids as unknown[]).map(String));
    const hits = retrieved.filter((id) => relevant.has(id)).length;
    const p = retrieved.length === 0 ? null : hits / retrieved.length;
    const r = relevant.size === 0 ? null : hits / relevant.size;
    const v = which === "p" ? p : which === "r" ? r : retrievalF1(p, r);
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Numeric details-field values for statistics (e.g. faithfulness). */
export function trialDetailValues(
  observations: readonly { details?: Record<string, unknown> }[],
  field: string,
): number[] {
  const out: number[] = [];
  for (const o of observations) {
    const v = o.details?.[field];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

reg("retrieval_precision", "mean |retrieved ∩ relevant|/|retrieved| over defined trials", (i) => meanDefined(retrievalPRs(i).map((x) => x.p)));
reg("retrieval_recall", "mean |retrieved ∩ relevant|/|relevant| over defined trials", (i) => meanDefined(retrievalPRs(i).map((x) => x.r)));
reg("retrieval_f1", "mean per-trial retrieval F1 over defined trials", (i) =>
  meanDefined(retrievalPRs(i).map((x) => retrievalF1(x.p, x.r))),
);
reg("context_relevance", "fraction of retrieved context that is relevant (mean precision); null when undefined", (i) =>
  meanDefined(retrievalPRs(i).map((x) => x.p)),
);
reg("faithfulness", "mean details.faithfulness (LLM-judge structured output); null when absent", (i) =>
  meanDefined(inputDetails(i, "faithfulness")),
);
reg("answer_correctness", "mean details.answer_correctness (LLM-judge structured output); null when absent", (i) =>
  meanDefined(inputDetails(i, "answer_correctness")),
);

function inputDetails(input: MetricInput, field: string): (number | null)[] {
  return input.observations.map((o) => {
    const v = (o.details as Record<string, unknown> | undefined)?.[field];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  });
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

/** Binary classification metrics from (predicted, actual) pairs. */
export function classificationMetrics(pairs: readonly { predicted: boolean; actual: boolean }[]): {
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
} {
  if (pairs.length === 0) return { accuracy: null, precision: null, recall: null, f1: null };
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const p of pairs) {
    if (p.predicted && p.actual) tp++;
    else if (!p.predicted && !p.actual) tn++;
    else if (p.predicted) fp++;
    else fn++;
  }
  const accuracy = (tp + tn) / pairs.length;
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  return { accuracy, precision, recall, f1 };
}

/**
 * ROC-AUC via the Mann-Whitney U statistic. Null when there are no pairs or
 * only one class is present (ranking a single class is undefined, not 0.5-by-fiat
 * in the metric — callers that need a default must choose it explicitly).
 */
export function rocAuc(pairs: readonly { score: number; actual: boolean }[]): number | null {
  const pos = pairs.filter((p) => p.actual).map((p) => p.score);
  const neg = pairs.filter((p) => !p.actual).map((p) => p.score);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  let ties = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins++;
      else if (p === n) ties++;
    }
  }
  return (wins + 0.5 * ties) / (pos.length * neg.length);
}

/**
 * PR-AUC as average precision: rank by score descending, average precision
 * at each true positive. Null when there are no pairs or no positives.
 */
export function prAuc(pairs: readonly { score: number; actual: boolean }[]): number | null {
  if (pairs.length === 0) return null;
  const totalPos = pairs.filter((p) => p.actual).length;
  if (totalPos === 0) return null;
  const ranked = [...pairs].sort((a, b) => b.score - a.score);
  let tp = 0;
  let sum = 0;
  ranked.forEach((p, i) => {
    if (p.actual) {
      tp++;
      sum += tp / (i + 1);
    }
  });
  return sum / totalPos;
}

/**
 * Expected calibration error: bin scores into `bins` equal-width buckets and
 * average |accuracy − confidence| weighted by bucket mass. Lower is better,
 * so gate it with `<=` thresholds. Null without scored pairs.
 */
export function expectedCalibrationError(
  pairs: readonly { score: number; actual: boolean }[],
  bins = 10,
): number | null {
  if (pairs.length === 0 || bins < 1) return null;
  const buckets: { n: number; pos: number; conf: number }[] = Array.from({ length: bins }, () => ({ n: 0, pos: 0, conf: 0 }));
  for (const p of pairs) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p.score * bins)));
    const bucket = buckets[b] as { n: number; pos: number; conf: number };
    bucket.n++;
    if (p.actual) bucket.pos++;
    bucket.conf += p.score;
  }
  let ece = 0;
  for (const bucket of buckets) {
    if (bucket.n === 0) continue;
    ece += (bucket.n / pairs.length) * Math.abs(bucket.pos / bucket.n - bucket.conf / bucket.n);
  }
  return ece;
}
