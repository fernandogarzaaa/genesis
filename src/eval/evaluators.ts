/**
 * Evaluators as first-class objects.
 *
 * - deterministic: exact match, regex, JSON-schema, inline JS predicate.
 * - reference: compare output against task.reference/expected.
 * - llm_command: run an external judge command (model-agnostic; captures judge
 *   model, prompt digest, raw output — the judge stays evaluable, never truth).
 * - human: import judgments from JSONL ({task_id, score|passed}).
 * - oracle: arbitrary external validator command → exit-zero means pass.
 * - composite: combine sub-evaluators (all/any) + score averaging.
 * - pass_through: trust subject output booleans (for self-eval harnesses).
 * - classification: compare a predicted label against task reference/labels.
 *   Records details {predicted, actual, predicted_bool, actual_bool, score?}
 *   so precision/recall/F1/ROC-AUC/PR-AUC/calibration aggregate honestly.
 *   Binary rates need a declared `positive` class (or boolean actuals).
 * - retrieval: compare retrieved ids against task relevant_ids. Records
 *   details {retrieved_ids, relevant_ids} for retrieval precision/recall/F1.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { redact } from "../shared/redact.js";
import { SubprocessRunner, type Runner } from "../evidence/runner.js";
import type { EvalTask, EvaluatorKind, Observation } from "./types.js";
import type { EvaluatorSpec } from "./spec.js";

export interface Evaluator {
  readonly name: string;
  readonly kind: EvaluatorKind;
  evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">>;
  describe(): Record<string, unknown>;
}

export function createEvaluator(spec: EvaluatorSpec, runner: Runner = new SubprocessRunner()): Evaluator {
  switch (spec.type) {
    case "exact":
      return new ExactEvaluator(spec);
    case "regex":
      return new RegexEvaluator(spec);
    case "json_schema":
      return new JsonSchemaEvaluator(spec);
    case "javascript":
      return new JavaScriptEvaluator(spec);
    case "command":
    case "oracle":
      return new CommandEvaluator(spec, runner);
    case "llm_command":
      return new LlmCommandEvaluator(spec, runner);
    case "human":
      return new HumanEvaluator(spec);
    case "composite":
      return new CompositeEvaluator(spec, runner);
    case "classification":
      return new ClassificationEvaluator(spec);
    case "retrieval":
      return new RetrievalEvaluator();
    case "pass_through":
      return new PassThroughEvaluator();
    default:
      throw new Error(`evaluator: unknown type "${(spec as { type: string }).type}"`);
  }
}

function norm(v: unknown): string {
  if (typeof v === "string") return v.trim();
  return JSON.stringify(v)?.trim() ?? String(v);
}

/** Exact match against reference/expected (or fixed field value). */
export class ExactEvaluator implements Evaluator {
  readonly name = "exact";
  readonly kind: EvaluatorKind = "reference";
  readonly #field?: string;
  constructor(spec: EvaluatorSpec) {
    this.#field = spec.field;
  }
  describe(): Record<string, unknown> {
    return { type: "exact", field: this.#field ?? null };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const ref = this.#field ? (task as unknown as Record<string, unknown>)[this.#field] : (task.reference ?? task.expected);
    const out = this.#field && output && typeof output === "object"
      ? (output as Record<string, unknown>)[this.#field]
      : output;
    const passed = norm(out) === norm(ref);
    return {
      evaluator: this.name, evaluator_kind: this.kind,
      score: passed ? 1 : 0, passed,
      details: { expected: norm(ref), observed: norm(out) },
    };
  }
}

/** Regex over stringified output. */
export class RegexEvaluator implements Evaluator {
  readonly name = "regex";
  readonly kind: EvaluatorKind = "deterministic";
  readonly #pattern: RegExp;
  readonly #source: string;
  constructor(spec: EvaluatorSpec) {
    if (!spec.pattern) throw new Error("evaluator regex: pattern is required");
    this.#source = spec.pattern;
    this.#pattern = new RegExp(spec.pattern);
  }
  describe(): Record<string, unknown> {
    return { type: "regex", pattern: this.#source };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    void task;
    const text = typeof output === "string" ? output : JSON.stringify(output);
    const passed = this.#pattern.test(text ?? "");
    return { evaluator: this.name, evaluator_kind: this.kind, score: passed ? 1 : 0, passed, details: { pattern: this.#source } };
  }
}

/** Minimal JSON-schema check (type/properties/required/enum) — no dependency. */
export class JsonSchemaEvaluator implements Evaluator {
  readonly name = "json_schema";
  readonly kind: EvaluatorKind = "deterministic";
  readonly #schema: Record<string, unknown>;
  constructor(spec: EvaluatorSpec) {
    if (!spec.schema) throw new Error("evaluator json_schema: schema is required");
    this.#schema = spec.schema;
  }
  describe(): Record<string, unknown> {
    return { type: "json_schema", schema: this.#schema };
  }
  async evaluate(_task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    let value = output;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return { evaluator: this.name, evaluator_kind: this.kind, score: 0, passed: false, details: { error: "not JSON" } };
      }
    }
    const errors = checkSchema(value, this.#schema, "$");
    return {
      evaluator: this.name, evaluator_kind: this.kind,
      score: errors.length === 0 ? 1 : 0, passed: errors.length === 0,
      details: errors.length > 0 ? { errors } : { valid: true },
    };
  }
}

function checkSchema(value: unknown, schema: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const type = schema.type as string | undefined;
  if (type) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = type === "integer" ? actual === "number" && Number.isInteger(value) : type === "number" ? actual === "number" : actual === type;
    if (!ok) {
      errors.push(`${path}: expected ${type}, got ${actual}`);
      return errors;
    }
  }
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    if (!(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errors.push(`${path}: not in enum`);
    }
  }
  if (schema.required !== undefined && value && typeof value === "object") {
    for (const k of schema.required as string[]) {
      if (!Object.hasOwn(value as object, k)) errors.push(`${path}: missing required "${k}"`);
    }
  }
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props && value && typeof value === "object") {
    for (const [k, sub] of Object.entries(props)) {
      if (Object.hasOwn(value as object, k)) errors.push(...checkSchema((value as Record<string, unknown>)[k], sub, `${path}.${k}`));
    }
  }
  return errors;
}

/** Inline JS predicate: script receives (output, task) and returns boolean/number/{score,passed}. */
export class JavaScriptEvaluator implements Evaluator {
  readonly name = "javascript";
  readonly kind: EvaluatorKind = "deterministic";
  readonly #script: string;
  constructor(spec: EvaluatorSpec) {
    if (!spec.script) throw new Error("evaluator javascript: script is required");
    this.#script = spec.script;
  }
  describe(): Record<string, unknown> {
    return { type: "javascript", script_digest: createHash("sha256").update(this.#script).digest("hex") };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    try {
      const fn = new Function("output", "task", this.#script) as (o: unknown, t: EvalTask) => unknown;
      const r = fn(output, task);
      if (typeof r === "boolean") return { evaluator: this.name, evaluator_kind: this.kind, score: r ? 1 : 0, passed: r };
      if (typeof r === "number") return { evaluator: this.name, evaluator_kind: this.kind, score: r, passed: r >= 0.5 };
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        const score = typeof o.score === "number" ? o.score as number : o.passed === true ? 1 : 0;
        return {
          evaluator: this.name, evaluator_kind: this.kind, score,
          passed: typeof o.passed === "boolean" ? (o.passed as boolean) : score >= 0.5,
          details: o,
        };
      }
      return { evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null, details: { raw: String(r) } };
    } catch (error) {
      return { evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null, details: { error: (error as Error).message } };
    }
  }
}

/** External command judge: task+output files → JSON {score|passed} on stdout. */
export class CommandEvaluator implements Evaluator {
  readonly name: string;
  readonly kind: EvaluatorKind;
  readonly #command: string;
  readonly #runner: Runner;
  constructor(spec: EvaluatorSpec, runner: Runner) {
    if (!spec.command) throw new Error("evaluator command/oracle: command is required");
    this.#command = spec.command;
    this.#runner = runner;
    this.kind = spec.type === "oracle" ? "oracle" : "deterministic";
    this.name = spec.type === "oracle" ? "oracle" : "command";
  }
  describe(): Record<string, unknown> {
    return { type: this.name, command: this.#command };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const dir = mkdtempSync(join(tmpdir(), "genesis-eval-"));
    try {
      const taskFile = join(dir, "task.json");
      const outputFile = join(dir, "output.json");
      writeFileSync(taskFile, JSON.stringify(task, null, 2), "utf8");
      writeFileSync(outputFile, typeof output === "string" ? output : JSON.stringify(output), "utf8");
      const parts = this.#command.split(/\s+/).map((p) =>
        p.replaceAll("{task_file}", taskFile).replaceAll("{output_file}", outputFile).replaceAll("{output}", outputFile),
      );
      const result = await this.#runner.run(parts, { cwd: process.cwd(), timeoutMs: 60_000 });
      if (result.spawn_error || result.timed_out) {
        return {
          evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null,
          details: { error: result.spawn_error ?? "evaluator timed out" },
        };
      }
      if (this.name === "oracle") {
        return {
          evaluator: this.name, evaluator_kind: this.kind,
          score: result.exit_code === 0 ? 1 : 0, passed: result.exit_code === 0,
          details: { exit_code: result.exit_code, stdout: redact(result.stdout).slice(0, 2000) },
        };
      }
      const parsed = parseJsonLoose(result.stdout);
      if (!parsed) {
        return {
          evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null,
          details: { error: "evaluator stdout was not JSON", stdout: redact(result.stdout).slice(0, 1000) },
        };
      }
      if (typeof parsed.passed === "boolean") {
        return {
          evaluator: this.name, evaluator_kind: this.kind,
          score: typeof parsed.score === "number" ? (parsed.score as number) : (parsed.passed ? 1 : 0),
          passed: parsed.passed as boolean, details: parsed,
        };
      }
      if (typeof parsed.score === "number") {
        return {
          evaluator: this.name, evaluator_kind: this.kind,
          score: parsed.score as number, passed: (parsed.score as number) >= 0.5, details: parsed,
        };
      }
      return { evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null, details: parsed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * LLM judge via external command. Captures judge model, prompt digest, raw
 * output. The score stays an observation — Genesis can audit this evaluator
 * with `genesis audit` or adversarial trials. Never ground truth.
 */
export class LlmCommandEvaluator implements Evaluator {
  readonly name = "llm";
  readonly kind: EvaluatorKind = "llm";
  readonly #command: string;
  readonly #model: string;
  readonly #rubric: string;
  readonly #runner: Runner;
  constructor(spec: EvaluatorSpec, runner: Runner) {
    if (!spec.command) throw new Error("evaluator llm_command: command is required (e.g. a judge CLI)");
    this.#command = spec.command;
    this.#model = spec.model ?? "unknown-judge";
    this.#rubric = spec.rubric ?? "";
    this.#runner = runner;
  }
  describe(): Record<string, unknown> {
    return {
      type: "llm_command", command: this.#command, judge_model: this.#model,
      rubric_digest: createHash("sha256").update(this.#rubric).digest("hex"),
    };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const dir = mkdtempSync(join(tmpdir(), "genesis-llm-"));
    try {
      const taskFile = join(dir, "task.json");
      const outputFile = join(dir, "output.json");
      writeFileSync(taskFile, JSON.stringify(task, null, 2), "utf8");
      writeFileSync(outputFile, typeof output === "string" ? output : JSON.stringify(output), "utf8");
      const parts = this.#command.split(/\s+/).map((p) =>
        p.replaceAll("{task_file}", taskFile).replaceAll("{output_file}", outputFile),
      );
      const result = await this.#runner.run(parts, { cwd: process.cwd(), timeoutMs: 120_000 });
      const promptDigest = createHash("sha256").update(JSON.stringify({ task, output, rubric: this.#rubric })).digest("hex");
      if (result.spawn_error || result.timed_out) {
        return {
          evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null,
          judge_model: this.#model, judge_prompt_digest: promptDigest,
          details: { error: result.spawn_error ?? "judge timed out" },
        };
      }
      const parsed = parseJsonLoose(result.stdout);
      const score = parsed && typeof parsed.score === "number" ? (parsed.score as number) : null;
      const passed = parsed && typeof parsed.passed === "boolean"
        ? (parsed.passed as boolean)
        : score !== null ? score >= 0.5 : null;
      return {
        evaluator: this.name, evaluator_kind: this.kind, score, passed,
        judge_model: this.#model, judge_prompt_digest: promptDigest,
        details: { raw: redact(result.stdout).slice(0, 4000), ...(parsed ?? {}) },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Human judgments imported from JSONL: {task_id, score} or {task_id, passed}. */
export class HumanEvaluator implements Evaluator {
  readonly name = "human";
  readonly kind: EvaluatorKind = "human";
  readonly #judgments = new Map<string, { score: number | null; passed: boolean | null }>();
  readonly #path: string;
  constructor(spec: EvaluatorSpec) {
    if (!spec.judgments) throw new Error("evaluator human: judgments path is required");
    this.#path = spec.judgments;
    const text = readFileSync(spec.judgments, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const row = JSON.parse(t) as Record<string, unknown>;
      const id = String(row.task_id ?? row.id ?? "");
      if (!id) continue;
      this.#judgments.set(id, {
        score: typeof row.score === "number" ? (row.score as number) : null,
        passed: typeof row.passed === "boolean" ? (row.passed as boolean) : null,
      });
    }
  }
  describe(): Record<string, unknown> {
    return { type: "human", judgments: this.#path, count: this.#judgments.size };
  }
  async evaluate(task: EvalTask, _output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const j = this.#judgments.get(task.id);
    if (!j) {
      return { evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null, details: { error: `no human judgment for ${task.id}` } };
    }
    return {
      evaluator: this.name, evaluator_kind: this.kind,
      score: j.score ?? (j.passed === true ? 1 : j.passed === false ? 0 : null),
      passed: j.passed ?? (j.score !== null ? j.score >= 0.5 : null),
      details: { rater: "human", task_id: task.id },
    };
  }
}

/** Combine sub-evaluators: all must pass (all) or any (any); scores averaged. */
export class CompositeEvaluator implements Evaluator {
  readonly name = "composite";
  readonly kind: EvaluatorKind = "composite";
  readonly #evals: Evaluator[];
  readonly #mode: "all" | "any";
  constructor(spec: EvaluatorSpec, runner: Runner) {
    if (!spec.evaluators || spec.evaluators.length === 0) throw new Error("evaluator composite: evaluators[] is required");
    this.#evals = spec.evaluators.map((e) => createEvaluator(e, runner));
    this.#mode = spec.mode ?? "all";
  }
  describe(): Record<string, unknown> {
    return { type: "composite", mode: this.#mode, evaluators: this.#evals.map((e) => e.describe()) };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const parts = await Promise.all(this.#evals.map((e) => e.evaluate(task, output)));
    const scores = parts.map((p) => p.score).filter((s): s is number => typeof s === "number");
    const passes = parts.map((p) => p.passed);
    const decided = passes.filter((p): p is boolean => typeof p === "boolean");
    const passed = decided.length === 0 ? null : this.#mode === "all" ? decided.every(Boolean) : decided.some(Boolean);
    const score = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    return {
      evaluator: this.name, evaluator_kind: this.kind, score, passed,
      details: { mode: this.#mode, parts: parts.map((p) => ({ evaluator: p.evaluator, score: p.score, passed: p.passed })) },
    };
  }
}

/** Trust boolean-ish subject output directly (self-eval harnesses). */
export class PassThroughEvaluator implements Evaluator {
  readonly name = "pass_through";
  readonly kind: EvaluatorKind = "deterministic";
  describe(): Record<string, unknown> {
    return { type: "pass_through" };
  }
  async evaluate(_task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    if (typeof output === "boolean") return { evaluator: this.name, evaluator_kind: this.kind, score: output ? 1 : 0, passed: output };
    if (typeof output === "number") return { evaluator: this.name, evaluator_kind: this.kind, score: output, passed: output >= 0.5 };
    if (typeof output === "string") {
      const t = output.trim().toLowerCase();
      if (["pass", "true", "1", "ok"].includes(t)) return { evaluator: this.name, evaluator_kind: this.kind, score: 1, passed: true };
      if (["fail", "false", "0"].includes(t)) return { evaluator: this.name, evaluator_kind: this.kind, score: 0, passed: false };
    }
    if (output && typeof output === "object") {
      const o = output as Record<string, unknown>;
      if (typeof o.passed === "boolean") {
        return {
          evaluator: this.name, evaluator_kind: this.kind,
          score: typeof o.score === "number" ? (o.score as number) : (o.passed ? 1 : 0),
          passed: o.passed as boolean,
        };
      }
    }
    return { evaluator: this.name, evaluator_kind: this.kind, score: null, passed: null, details: { note: "unreadable output" } };
  }
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const p: unknown = JSON.parse(c);
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Classification: predicted label vs ground truth.
 *
 * Actual comes from task.reference ?? task.expected ?? task.labels.actual.
 * Predicted is the raw output, or output.label/predicted/class for objects.
 * A numeric `scoreField` is recorded when present for ROC-AUC / PR-AUC /
 * calibration. Binary booleans resolve against the declared `positive` class
 * (default true when the actual is boolean); multiclass tasks without a
 * declared positive class record raw labels only, and binary-only metrics
 * honestly return null for them.
 */
export class ClassificationEvaluator implements Evaluator {
  readonly name = "classification";
  readonly kind: EvaluatorKind = "reference";
  readonly #positive: unknown;
  readonly #hasPositive: boolean;
  readonly #scoreField?: string;
  constructor(spec: EvaluatorSpec) {
    this.#hasPositive = spec.positive !== undefined;
    this.#positive = spec.positive;
    this.#scoreField = spec.scoreField;
  }
  describe(): Record<string, unknown> {
    return {
      type: "classification",
      ...(this.#hasPositive ? { positive: this.#positive } : {}),
      ...(this.#scoreField ? { scoreField: this.#scoreField } : {}),
    };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const actual: unknown =
      task.reference ?? task.expected ?? task.labels?.actual ?? null;
    let predictedRaw: unknown = output;
    let score: number | null = null;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const o = output as Record<string, unknown>;
      if (this.#scoreField && typeof o[this.#scoreField] === "number") {
        score = o[this.#scoreField] as number;
      }
      const label = o.label ?? o.predicted ?? o.class ?? o.prediction;
      if (label !== undefined) predictedRaw = label;
      else if (score !== null) predictedRaw = score >= 0.5;
    }
    const match = norm(predictedRaw) === norm(actual);
    const { predicted, actualBool } = toBooleans(predictedRaw, actual, match, this.#hasPositive, this.#positive);
    return {
      evaluator: this.name, evaluator_kind: this.kind,
      score: match ? 1 : 0, passed: match,
      details: {
        predicted: printable(predictedRaw),
        actual: printable(actual),
        ...(predicted !== null ? { predicted_bool: predicted } : {}),
        ...(actualBool !== null ? { actual_bool: actualBool } : {}),
        ...(score !== null ? { score } : {}),
      },
    };
  }
}

function toBooleans(
  predictedRaw: unknown,
  actual: unknown,
  match: boolean,
  hasPositive: boolean,
  positive: unknown,
): { predicted: boolean | null; actualBool: boolean | null } {
  if (hasPositive) {
    return {
      predicted: norm(predictedRaw) === norm(positive),
      actualBool: norm(actual) === norm(positive),
    };
  }
  if (typeof actual === "boolean") {
    return {
      actualBool: actual,
      predicted: typeof predictedRaw === "boolean" ? predictedRaw : match ? actual : !actual,
    };
  }
  return { predicted: null, actualBool: null };
}

/**
 * Retrieval: retrieved ids vs relevant ids.
 *
 * Relevant ids come from task.labels.relevant_ids ?? task.metadata.relevant_ids
 * ?? task.context.relevant_ids. Retrieved ids come from an array output or
 * output.retrieved_ids/retrieved/ids. Score is per-trial F1; passed is F1>=0.5.
 * Undefined cases (no retrieved docs, no relevant docs) record nulls so the
 * metrics average over defined trials instead of inventing zeroes.
 */
export class RetrievalEvaluator implements Evaluator {
  readonly name = "retrieval";
  readonly kind: EvaluatorKind = "reference";
  describe(): Record<string, unknown> {
    return { type: "retrieval" };
  }
  async evaluate(task: EvalTask, output: unknown): Promise<Omit<Observation, "trial_id" | "task_id">> {
    const relevant = idList(
      task.labels?.relevant_ids ??
        task.metadata?.relevant_ids ??
        (task.context as Record<string, unknown> | undefined)?.relevant_ids,
    );
    let retrieved: string[] | null = null;
    if (Array.isArray(output)) retrieved = idList(output);
    else if (output && typeof output === "object") {
      const o = output as Record<string, unknown>;
      const cand = o.retrieved_ids ?? o.retrieved ?? o.ids;
      if (cand !== undefined) retrieved = idList(cand);
    }
    const pr = retrievalPR(retrieved, relevant);
    // F1 is 0 (not null) when both sides are defined but share nothing;
    // null only when precision/recall themselves are undefined.
    const f1 = pr.p === null || pr.r === null ? null : pr.p + pr.r > 0 ? (2 * pr.p * pr.r) / (pr.p + pr.r) : 0;
    return {
      evaluator: this.name, evaluator_kind: this.kind,
      score: f1, passed: f1 === null ? null : f1 >= 0.5,
      details: {
        ...(retrieved !== null ? { retrieved_ids: retrieved } : { retrieved_ids: null }),
        ...(relevant !== null ? { relevant_ids: relevant } : { relevant_ids: null }),
        ...(pr.p !== null ? { precision: pr.p } : {}),
        ...(pr.r !== null ? { recall: pr.r } : {}),
        ...(f1 !== null ? { f1 } : {}),
      },
    };
  }
}

export function idList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x)));
}

export function retrievalPR(
  retrieved: readonly string[] | null,
  relevant: readonly string[] | null,
): { p: number | null; r: number | null } {
  if (retrieved === null || relevant === null) return { p: null, r: null };
  const rel = new Set(relevant);
  const hits = retrieved.filter((id) => rel.has(id)).length;
  return {
    p: retrieved.length === 0 ? null : hits / retrieved.length,
    r: relevant.length === 0 ? null : hits / relevant.length,
  };
}

function printable(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 500);
  try {
    return (JSON.stringify(v) ?? String(v)).slice(0, 500);
  } catch {
    return String(v).slice(0, 500);
  }
}
