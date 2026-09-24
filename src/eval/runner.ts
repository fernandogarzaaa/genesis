/**
 * Experiment runner: dataset → subject → evaluator → metrics → evidence → verdict.
 *
 * Each (task × repetition × seed) is a Trial. Each trial gets an Observation
 * from the evaluator and an EvidenceRecord with provenance + digest. Baselines
 * run over the same population for paired comparison. Ablations run as named
 * arms. Nothing collapses trials into an opaque score: raw trials ship in the
 * evidence bundle.
 */

import { createHash } from "node:crypto";
import { canonicalize, hashCanonicalExcluding } from "../shared/canonical.js";
import { redact, redactDeep } from "../shared/redact.js";
import { SubprocessRunner, type Runner } from "../evidence/runner.js";
import { createEvaluator, type Evaluator } from "./evaluators.js";
import { createSubject, type SubjectAdapter, type SubjectResult } from "./subjects.js";
import { loadDataset, type LoadedDataset } from "./dataset.js";
import { computeMetric, metricNames } from "./metrics.js";
import { trialDetailValues, trialRetrievalValues } from "./metrics.js";
import { describe, describeRate, pairedCompare } from "./stats.js";
import { decideVerdict } from "./verdict.js";
import type {
  EvalFinding, EvalTask, EvidenceRecord, MetricValue, Observation, PairedComparison,
  StatisticalResult, Trial, VerdictRecord,
} from "./types.js";
import type { EvalSpec } from "./spec.js";
import type { SubjectSpec } from "./spec.js";
import { SpecError } from "./spec.js";

export interface ArmResult {
  readonly arm: string;
  readonly trials: Trial[];
  readonly observations: Observation[];
  readonly evidence: EvidenceRecord[];
  readonly metrics: MetricValue[];
  readonly statistics: (StatisticalResult | null)[];
  /** Inter-rater agreement when the evaluator reports it (human + second rater). */
  readonly evaluator_agreement?: {
    readonly cohen_kappa: number | null;
    readonly n: number;
    readonly interpretation: string | null;
  } | null;
}

export interface ExperimentResult {
  readonly name: string;
  readonly dataset: LoadedDataset["info"];
  readonly spec_digest: string;
  readonly arms: ArmResult[];
  readonly comparisons: PairedComparison[];
  readonly verdict: VerdictRecord;
  readonly findings: EvalFinding[];
  readonly started_at: string;
  readonly ended_at: string;
}

export async function runExperiment(
  spec: EvalSpec,
  options: { stdinData?: string; runner?: Runner } = {},
): Promise<ExperimentResult> {
  const started_at = new Date().toISOString();
  const runner = options.runner ?? new SubprocessRunner();
  const subjectSpec = spec.subject;
  if (!subjectSpec) {
    throw new SpecError("spec.subject is required to run (benchmark templates declare it via --subject at run time)");
  }
  const dataset = loadDataset({
    path: spec.dataset.path,
    inline: spec.dataset.inline,
    stdin: options.stdinData !== undefined ? options.stdinData : spec.dataset.stdin ? await readStdin() : undefined,
    format: spec.dataset.format,
    id: spec.dataset.id ?? spec.dataset.path ?? "dataset",
    version: spec.dataset.version ?? "1",
  });
  if (dataset.tasks.length === 0) {
    throw new Error("dataset contains no tasks");
  }

  const repetitions = spec.repetitions ?? spec.claim?.methodology?.repetitions ?? 1;
  const seeds = spec.seeds ?? spec.claim?.methodology?.seeds ?? [1];
  const evaluator = createEvaluator(spec.evaluator, runner);
  const metricList = spec.metrics ?? spec.claim?.evaluation?.metrics ?? ["task_success"];

  const arms: ArmResult[] = [];
  arms.push(await runArm("treatment", subjectSpec.name ?? "candidate", spec, dataset, evaluator, runner, repetitions, seeds));
  if (spec.baseline) {
    arms.push(await runArm("baseline", spec.baseline.name ?? "baseline", spec, dataset, evaluator, runner, repetitions, seeds, spec.baseline));
  }
  for (const abl of spec.ablations ?? []) {
    arms.push(await runArm(`ablation:${abl.name}`, abl.name, spec, dataset, evaluator, runner, repetitions, seeds, abl.subject));
  }
  if (spec.sanity_baseline) {
    // Degenerate policies: doing nothing and deterministic gibberish.
    // A healthy evaluator/reward scores them ~0; anything higher is a
    // reward-sanity finding, not a system achievement.
    arms.push(await runArm("sanity:empty", "sanity-empty", spec, dataset, evaluator, runner, repetitions, seeds, { inline: "empty" }));
    arms.push(await runArm("sanity:random", "sanity-random", spec, dataset, evaluator, runner, repetitions, seeds, { inline: "random" }));
  }

  // Metrics + stats per arm.
  const withMetrics: ArmResult[] = arms.map((arm) => {
    const metrics: MetricValue[] = [];
    for (const name of metricList) {
      try {
        const { value, unit } = computeMetric(name, { trials: arm.trials, observations: arm.observations });
        if (value !== null) metrics.push({ metric: name, value, n: arm.trials.length, ...(unit ? { unit } : {}) });
      } catch {
        // Unknown metric → skip (surfaced in findings as INVALID config).
      }
    }
    const statistics: (StatisticalResult | null)[] = metrics.map((m) => statisticFor(m.metric, arm));
    return { ...arm, metrics, statistics };
  });

  // Paired comparisons: treatment vs baseline/ablations (sanity arms excluded —
  // degenerate policies are diagnostics, not comparison arms).
  const comparisons: PairedComparison[] = [];
  const treatment = withMetrics[0];
  const comparable = withMetrics.slice(1).filter((a) => !a.arm.startsWith("sanity:"));
  if (treatment && comparable.length > 0) {
    for (const other of comparable) {
      for (const m of metricList) {
        const b = perTaskMeans(other, m);
        const t = perTaskMeans(treatment as ArmResult, m);
        const c = pairedCompare(b, t, `${m} (${other.arm} → treatment)`);
        if (c) comparisons.push(c);
      }
    }
  }

  const verdict = decideVerdict({
    claim: spec.claim,
    metrics: (treatment as ArmResult)?.metrics ?? [],
    thresholds: spec.thresholds,
    datasetLabel: `${dataset.info.id}@${dataset.info.version}`,
    datasetDigest: dataset.info.digest,
    sampleSize: dataset.tasks.length,
    repetitions,
    conditions: {
      subject: (treatment as ArmResult)?.arm,
      evaluator: evaluator.describe(),
      paired: spec.paired ?? spec.claim?.methodology?.paired ?? true,
      seeds,
    },
    insufficientEvidence: spec.claim?.conclusion_policy?.insufficient_evidence,
  });

  const findings = buildFindings(withMetrics, verdict, spec.sanity_threshold ?? 0.1);
  const ended_at = new Date().toISOString();
  const spec_digest = createHash("sha256").update(canonicalize(spec as unknown as Record<string, unknown>)).digest("hex");

  return { name: spec.name, dataset: dataset.info, spec_digest, arms: withMetrics, comparisons, verdict, findings, started_at, ended_at };
}

async function runArm(
  armId: string,
  subjectName: string,
  spec: EvalSpec,
  dataset: LoadedDataset,
  evaluator: Evaluator,
  runner: Runner,
  repetitions: number,
  seeds: readonly (number | string)[],
  subjectOverride?: EvalSpec["subject"],
): Promise<ArmResult> {
  const subject: SubjectAdapter = createSubject(subjectOverride ?? subjectSpecFor(spec), runner);
  const maxTurns = spec.max_turns ?? null;
  const trials: Trial[] = [];
  const observations: Observation[] = [];
  const evidence: EvidenceRecord[] = [];
  let n = 0;
  for (const task of dataset.tasks) {
    for (let rep = 0; rep < repetitions; rep++) {
      const seed = seeds[rep % seeds.length] ?? null;
      n++;
      const trial_id = `${armId}/trial-${String(n).padStart(5, "0")}`;
      const t0 = new Date().toISOString();
      const s0 = Date.now();
      const convo = await runConversation(subject, task, rep, seed, maxTurns);
      const duration_ms = Date.now() - s0;
      const t1 = new Date().toISOString();
      // Fail-closed (extends single-shot rule to conversations): a later turn
      // that errors/times out withholds the stale earlier answer — scoring it
      // would mark an incomplete interaction successful.
      const failed = isFailedExecution({ error: convo.error, timed_out: convo.timed_out, exit_code: convo.exit_code });
      const trial: Trial = {
        trial_id, task_id: task.id, repetition: rep + 1, seed,
        subject: subjectName, started_at: t0, ended_at: t1,
        duration_ms, timed_out: convo.timed_out, error: convo.error,
        output: truncateOutput(failed ? null : convo.final),
        ...(convo.transcript ? { transcript: redactDeep(convo.transcript) } : {}),
      };
      trials.push(trial);
      let obs: Omit<Observation, "trial_id" | "task_id">;
      if (failed) {
        // Never invoke the evaluator on failed execution (single-shot or
        // multi-turn): partial/stale output could still "pass" and produce
        // SUPPORTED from a failed run.
        obs = {
          evaluator: evaluator.name, evaluator_kind: "deterministic",
          score: null, passed: null,
          details: {
            unjudged: true,
            reason: convo.timed_out
              ? "subject timed out"
              : convo.error ?? `subject failed (exit ${convo.exit_code})`,
            exit_code: convo.exit_code,
            timed_out: convo.timed_out,
          },
        };
      } else {
        try {
          obs = await evaluator.evaluate(task, convo.final);
        } catch (error) {
          obs = {
            evaluator: evaluator.name, evaluator_kind: "deterministic",
            score: null, passed: null, details: { error: (error as Error).message },
          };
        }
      }
      const observation: Observation = { trial_id, task_id: task.id, ...obs };
      observations.push(observation);
      // Evidence digest binds the FULL record (trial + observation +
      // provenance + timestamps), excluding only its own digest field.
      // The old {trial_id, task_id, observation} digest is kept as
      // legacy_digest for verification of historic bundles — computed first
      // so the v2 digest binds it too. A verifier reproduces `digest` by
      // hashing the stored record minus `digest` alone.
      // Provenance is built once and reused: the digested body and the
      // stored record must carry identical provenance (incl. `turns`),
      // or verifiers cannot reproduce the digest.
      const provenance: Record<string, unknown> = {
        subject: subject.describe(), evaluator: evaluator.describe(),
        exit_code: convo.exit_code, duration_ms, timed_out: convo.timed_out,
        error: convo.error,
        ...(convo.turns !== null ? { turns: convo.turns } : {}),
      };
      const legacyDigest = createHash("sha256")
        .update(canonicalize({ trial_id, task_id: task.id, observation } as unknown as Record<string, unknown>))
        .digest("hex");
      const evidenceBody = {
        source: `subject:${subjectName}|evaluator:${evaluator.name}`,
        timestamp: t1, task_id: task.id, trial_id,
        trial, observation, artifact_digest: null,
        legacy_digest: legacyDigest,
        provenance,
        confidence: null,
      };
      const digest = hashCanonicalExcluding(
        stripUndefined(evidenceBody) as unknown as Record<string, unknown>,
        ["digest"],
      );
      evidence.push({
        digest, source: `subject:${subjectName}|evaluator:${evaluator.name}`,
        timestamp: t1, task_id: task.id, trial_id,
        trial, observation, artifact_digest: null,
        legacy_digest: legacyDigest,
        provenance,
        confidence: null,
      });
    }
  }
  const agreement = typeof (evaluator as { agreement?: unknown }).agreement === "function"
    ? ((evaluator as unknown as { agreement(): ArmResult["evaluator_agreement"] }).agreement() ?? null)
    : null;
  return {
    arm: armId, trials, observations, evidence, metrics: [], statistics: [],
    ...(agreement ? { evaluator_agreement: agreement } : {}),
  };
}

/** Legacy alias (kept for external callers): size-bounded output. */
export function redactUnknown(v: unknown): unknown {
  return truncateOutput(v);
}

/** Fail-closed execution gate: any error/timeout/nonzero exit is failed. */
export function isFailedExecution(out: {
  readonly error: string | null;
  readonly timed_out: boolean;
  readonly exit_code: number | null;
}): boolean {
  if (out.timed_out) return true;
  if (out.error !== null) return true;
  if (out.exit_code !== null && out.exit_code !== 0) return true;
  return false;
}

const MAX_OUTPUT_CHARS = 20000;

/**
 * Size-bounded output carrier. Strings/JSON above the cap become a valid
 * envelope {truncated, excerpt, byte_count, digest} instead of `[object
 * Object]` (old JSON.parse(slice) fallback) — evidence is preserved and the
 * full content stays addressable by digest.
 */
export function truncateOutput(v: unknown): unknown {
  if (typeof v === "string") {
    const redacted = redact(v);
    if (redacted.length <= MAX_OUTPUT_CHARS) return redacted;
    return {
      truncated: true,
      excerpt: redacted.slice(0, MAX_OUTPUT_CHARS),
      byte_count: redacted.length,
      digest: `sha256:${createHash("sha256").update(redacted).digest("hex")}`,
    };
  }
  // Deep-redact structured output before measuring so the stored copy never
  // carries secrets that string-level redaction would miss on nesting.
  const cleaned = redactDeep(v);
  try {
    const s = JSON.stringify(cleaned);
    if (!s || s.length <= MAX_OUTPUT_CHARS) return cleaned;
    return {
      truncated: true,
      excerpt: s.slice(0, MAX_OUTPUT_CHARS),
      byte_count: s.length,
      digest: `sha256:${createHash("sha256").update(s).digest("hex")}`,
    };
  } catch {
    return String(v).slice(0, MAX_OUTPUT_CHARS);
  }
}

/**
 * Single-shot or multi-turn subject execution.
 *
 * Without task turns: one invocation, transcript null. With turns: one
 * invocation per turn prompt, each receiving {task, history, turn} where
 * history accumulates {role, content} pairs. A turn output shaped
 * {message, done} advances with `message` and stops early on done=true;
 * anything else is the message verbatim. The evaluator always judges the
 * final message; the transcript is preserved evidence.
 */
async function runConversation(
  subject: SubjectAdapter,
  task: EvalTask,
  repetition: number,
  seed: number | string | null,
  maxTurns: number | null,
): Promise<{
  final: unknown;
  transcript: { role: string; content: string }[] | null;
  turns: number | null;
  timed_out: boolean;
  error: string | null;
  exit_code: number | null;
}> {
  if (!task.turns || task.turns.length === 0) {
    try {
      const out = await subject.run(task, repetition, seed);
      return {
        final: out.output, transcript: null, turns: null,
        timed_out: out.timed_out, error: out.error, exit_code: out.exit_code,
      };
    } catch (error) {
      return {
        final: null, transcript: null, turns: null,
        timed_out: false, error: (error as Error).message, exit_code: null,
      };
    }
  }
  const limit = Math.min(task.turns.length, maxTurns ?? task.turns.length);
  const transcript: { role: string; content: string }[] = [];
  let final: unknown = null;
  let timedOut = false;
  let error: string | null = null;
  let exitCode: number | null = null;
  let turns = 0;
  for (let i = 0; i < limit; i++) {
    const prompt = task.turns[i];
    const promptText = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    transcript.push({ role: "user", content: promptText });
    const turnTask: EvalTask = {
      ...task,
      id: `${task.id}#turn${i + 1}`,
      input: prompt,
      context: { ...(task.context as Record<string, unknown> ?? {}), history: [...transcript], turn: i + 1 },
    };
    let out: SubjectResult;
    try {
      out = await subject.run(turnTask, repetition, seed);
    } catch (err) {
      // Withhold stale earlier answers: a failed conversation has no final.
      error = (err as Error).message;
      final = null;
      break;
    }
    if (out.timed_out) {
      timedOut = true;
      error = out.error;
      exitCode = out.exit_code;
      final = null;
      break;
    }
    if (out.error) {
      error = out.error;
      exitCode = out.exit_code;
      final = null;
      break;
    }
    exitCode = out.exit_code;
    const { message, done } = turnMessage(out.output);
    transcript.push({ role: "assistant", content: message });
    final = message;
    turns = i + 1;
    if (done) break;
  }
  return { final, transcript, turns, timed_out: timedOut, error, exit_code: exitCode };
}

function turnMessage(output: unknown): { message: string; done: boolean } {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = output as Record<string, unknown>;
    if (typeof o.message === "string") {
      return { message: o.message, done: o.done === true };
    }
  }
  return { message: typeof output === "string" ? output : JSON.stringify(output) ?? String(output), done: false };
}

/**
 * Recursively drop `undefined` (canonical JSON rejects it — stringify would
 * silently drop those fields and produce colliding digests). Keeps nulls.
 */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = stripUndefined(val);
    }
    return out as unknown as T;
  }
  return v;
}

function perTaskMeans(arm: ArmResult, metric: string): Map<string, number> {
  // Per-trial decomposable value for this metric, averaged per task.
  // Aggregate-only metrics (precision/recall/F1/ROC/PR-AUC/ECE) are not
  // decomposable per trial → empty map → no paired comparison row.
  const perTrial: { task_id: string; value: number }[] = [];
  if (metric.includes("latency") || metric.includes("cost") || metric.includes("token") || metric === "mean_steps" || metric === "mean_turns") {
    for (const t of arm.trials) {
      const v = trialMetricValue(t, metric);
      if (v !== null) perTrial.push({ task_id: t.task_id, value: v });
    }
  } else if (metric === "retrieval_precision" || metric === "context_relevance") {
    arm.observations.forEach((o) => {
      const v = trialRetrievalValues([o], "p")[0];
      if (v !== undefined) perTrial.push({ task_id: o.task_id, value: v });
    });
  } else if (metric === "retrieval_recall") {
    arm.observations.forEach((o) => {
      const v = trialRetrievalValues([o], "r")[0];
      if (v !== undefined) perTrial.push({ task_id: o.task_id, value: v });
    });
  } else if (metric === "retrieval_f1") {
    arm.observations.forEach((o) => {
      const v = trialRetrievalValues([o], "f1")[0];
      if (v !== undefined) perTrial.push({ task_id: o.task_id, value: v });
    });
  } else if (metric === "faithfulness" || metric === "answer_correctness") {
    arm.observations.forEach((o) => {
      const v = trialDetailValues([o], metric)[0];
      if (v !== undefined) perTrial.push({ task_id: o.task_id, value: v });
    });
  } else if (metric.startsWith("detail:")) {
    arm.observations.forEach((o) => {
      const v = trialDetailValues([o], metric.slice("detail:".length))[0];
      if (v !== undefined) perTrial.push({ task_id: o.task_id, value: v });
    });
  } else if (
    metric === "precision" || metric === "recall" || metric === "f1" ||
    metric === "roc_auc" || metric === "pr_auc" || metric === "calibration_ece"
  ) {
    return new Map();
  } else {
    for (const o of arm.observations) {
      if (typeof o.score === "number") perTrial.push({ task_id: o.task_id, value: o.score });
      else if (typeof o.passed === "boolean" && (metric === "task_success" || metric === "accuracy")) {
        perTrial.push({ task_id: o.task_id, value: o.passed ? 1 : 0 });
      }
    }
  }
  const byTask = new Map<string, number[]>();
  for (const { task_id, value } of perTrial) {
    const l = byTask.get(task_id) ?? [];
    l.push(value);
    byTask.set(task_id, l);
  }
  const out = new Map<string, number>();
  for (const [k, vals] of byTask) out.set(k, vals.reduce((a, b) => a + b, 0) / vals.length);
  return out;
}

function trialMetricValue(t: Trial, metric: string): number | null {  switch (metric) {
    case "mean_latency_ms":
    case "p50_latency_ms":
    case "p95_latency_ms":
    case "p99_latency_ms":
      return t.duration_ms;
    case "total_cost_usd":
    case "mean_cost_usd":
      return t.cost?.estimated_usd ?? null;
    case "total_tokens":
      return t.cost?.total_tokens ?? null;
    case "mean_turns":
      return t.transcript ? t.transcript.filter((m) => m.role === "assistant").length : null;
    default:
      return null;
  }
}

function perTrialValues(arm: ArmResult, metric: string): number[] {
  return arm.trials.map((t) => trialMetricValue(t, metric)).filter((v): v is number => typeof v === "number");
}

/**
 * Interval population per metric. Rate metrics over Bernoulli trials get
 * Wilson intervals; mean metrics describe their own per-trial values so the
 * reported point and interval always agree. Aggregate-only metrics
 * (precision/recall/F1/ROC/PR-AUC/ECE) have no per-trial distribution and
 * honestly report no interval — the point estimate stands with n.
 */
function statisticFor(metric: string, arm: ArmResult): StatisticalResult | null {
  if (metric === "task_success" || metric === "accuracy" || metric === "exact_match") {
    const succ = arm.observations.filter((o) => o.passed === true).length;
    const decided = arm.observations.filter((o) => typeof o.passed === "boolean").length;
    return describeRate(succ, decided, metric);
  }
  if (metric === "retrieval_precision" || metric === "context_relevance") {
    return describe(trialRetrievalValues(arm.observations, "p"), metric);
  }
  if (metric === "retrieval_recall") {
    return describe(trialRetrievalValues(arm.observations, "r"), metric);
  }
  if (metric === "retrieval_f1") {
    return describe(trialRetrievalValues(arm.observations, "f1"), metric);
  }
  if (metric === "faithfulness" || metric === "answer_correctness") {
    return describe(trialDetailValues(arm.observations, metric), metric);
  }
  if (metric.startsWith("detail:")) {
    return describe(trialDetailValues(arm.observations, metric.slice("detail:".length)), metric);
  }
  if (
    metric === "precision" || metric === "recall" || metric === "f1" ||
    metric === "roc_auc" || metric === "pr_auc" || metric === "calibration_ece"
  ) {
    return null;
  }
  const values = metric.includes("latency") || metric.includes("cost") || metric.includes("token") || metric === "mean_steps" || metric === "mean_turns"
    ? perTrialValues(arm, metric)
    : arm.observations.map((o) => o.score).filter((s): s is number => typeof s === "number");
  return describe(values, metric);
}

function buildFindings(arms: ArmResult[], verdict: VerdictRecord, sanityThreshold: number): EvalFinding[] {
  const findings: EvalFinding[] = [];
  for (const arm of arms.filter((a) => a.arm.startsWith("sanity:"))) {
    const judged = arm.observations.filter((o) => typeof o.passed === "boolean").length;
    const passed = arm.observations.filter((o) => o.passed === true).length;
    const rate = judged === 0 ? 0 : passed / judged;
    if (rate > sanityThreshold) {
      findings.push({
        category: "reward-sanity",
        severity: "major",
        summary: `Degenerate policy "${arm.arm}" scores ${Math.round(rate * 10000) / 100}% — doing nothing (or gibberish) earns reward. The evaluator or reward signal is broken; no verdict built on it can be trusted.`,
        evidence_digests: arm.evidence.slice(0, 20).map((e) => e.digest),
        affected_tasks: [...new Set(arm.observations.map((o) => o.task_id))].slice(0, 20),
        observed_behavior: `Degenerate outputs accepted at rate ${Math.round(rate * 10000) / 10000}.`,
        expected_behavior: `Degenerate policies score <= ${sanityThreshold}.`,
        possible_cause: "Reward hackable without doing the task (broken RL environment), over-permissive evaluator, or leaked answers. Filter the environment and assure the evaluator.",
        confidence: null,
        evaluator_audit: { verdict: "EXPLOITABLE", detail: "degenerate policies earn reward" },
      });
    }
  }  for (const arm of arms) {
    const failed = arm.observations.filter((o) => o.passed === false);
    if (failed.length > 0) {
      const byTask = new Map<string, Observation[]>();
      for (const o of failed) {
        const l = byTask.get(o.task_id) ?? [];
        l.push(o);
        byTask.set(o.task_id, l);
      }
      const worst = [...byTask.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
      findings.push({
        category: "task-failure",
        severity: failed.length / Math.max(1, arm.observations.length) > 0.2 ? "major" : "minor",
        summary: `${failed.length}/${arm.observations.length} observations failed in arm "${arm.arm}". Worst tasks: ${worst.map(([t, os]) => `${t}×${os.length}`).join(", ")}.`,
        evidence_digests: arm.evidence.filter((e) => failed.some((f) => f.trial_id === e.trial_id)).slice(0, 20).map((e) => e.digest),
        affected_tasks: [...byTask.keys()].slice(0, 20),
        observed_behavior: "Subject output did not satisfy the evaluator.",
        expected_behavior: "Evaluator criteria (see spec.evaluator) satisfied for every trial.",
        possible_cause: "Subject defect, evaluator over-strictness, or task/evaluator mismatch — inspect evidence before concluding.",
        confidence: null,
      });
    }
    const errored = arm.observations.filter((o) => o.passed === null);
    if (errored.length > 0) {
      findings.push({
        category: "evaluator-gap",
        severity: "major",
        summary: `${errored.length}/${arm.observations.length} observations could not be judged in arm "${arm.arm}" (evaluator returned null). Verdict cannot rely on these trials.`,
        evidence_digests: arm.evidence.filter((e) => errored.some((f) => f.trial_id === e.trial_id)).slice(0, 20).map((e) => e.digest),
        affected_tasks: [...new Set(errored.map((o) => o.task_id))].slice(0, 20),
        possible_cause: "Evaluator misconfiguration, unreadable subject output, or missing human judgments. Audit the evaluator (`genesis audit evaluator`).",
        confidence: null,
        evaluator_audit: { verdict: "UNRELIABLE", detail: "evaluator produced null judgments; assure before trusting" },
      });
    }
  }
  if (verdict.verdict === "INCONCLUSIVE") {
    findings.push({
      category: "insufficient-evidence",
      severity: "info",
      summary: `Verdict INCONCLUSIVE: ${verdict.summary}`,
      evidence_digests: [],
      affected_tasks: [],
      confidence: null,
    });
  }
  void metricNames;
  return findings;
}

function subjectSpecFor(spec: EvalSpec): SubjectSpec {
  const s = spec.subject;
  if (!s) throw new SpecError("spec.subject is required to run (benchmark templates declare it via --subject at run time)");
  return s;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
