/**
 * Declarative evaluation specification.
 *
 * Users write YAML/JSON; Genesis executes. Supports claim-first (claim file +
 * evaluation file) and standalone evaluation files. Never executes on load.
 */

import { readFileSync } from "node:fs";
import { validateClaim } from "./claim.js";
import type { Claim } from "./types.js";

export interface EvalSpec {
  readonly name: string;
  readonly claim?: Claim;
  readonly claim_ref?: string;
  /**
   * Present on benchmark templates: reusable workloads that declare
   * everything except the subject (supplied at run time via --subject).
   * A spec without `subject` and without `benchmark` is invalid.
   */
  readonly benchmark?: { readonly version?: string; readonly description?: string };
  readonly dataset: {
    readonly path?: string;
    readonly inline?: readonly unknown[];
    readonly stdin?: boolean;
    readonly format?: "json" | "jsonl" | "csv" | "yaml" | "text" | "dir" | "auto";
    readonly id?: string;
    readonly version?: string;
  };
  readonly subject?: SubjectSpec;
  readonly baseline?: SubjectSpec;
  readonly ablations?: readonly { readonly name: string; readonly subject: SubjectSpec }[];
  readonly evaluator: EvaluatorSpec;
  readonly metrics?: readonly string[];
  readonly repetitions?: number;
  /** Cap on multi-turn loop iterations (default: task turn count). */
  readonly max_turns?: number;
  readonly seeds?: readonly (number | string)[];
  readonly paired?: boolean;
  readonly timeout_ms?: number;
  readonly thresholds?: Record<string, string>;
  readonly regression?: {
    readonly baseline_run?: string;
    readonly quality?: { readonly max_drop?: number };
    readonly p95_latency?: { readonly max_increase?: number };
    readonly cost?: { readonly max_increase?: number };
  };
  /**
   * Release gate (capability checkpoint): metric ceilings that must NOT be
   * reached. `genesis gate` BLOCKS when any forbidden metric meets/exceeds
   * its ceiling, when evidence is missing, or when the evaluator is untrusted.
   */
  readonly gate?: { readonly forbidden?: Record<string, number> };
  /**
   * Degenerate-policy sanity arms: adds `sanity:empty` and `sanity:random`
   * arms (doing nothing / gibberish must score ~0). A `reward-sanity`
   * finding fires when they exceed `sanity_threshold` (default 0.1) —
   * the generalizeable form of broken-RL-environment filtering.
   */
  readonly sanity_baseline?: boolean;
  readonly sanity_threshold?: number;
  /** External analysis files (e.g. interpretability notes) copied into the bundle. */
  readonly analysis?: readonly string[];
  readonly output?: { readonly dir?: string };
}

export interface SubjectSpec {
  readonly name?: string;
  /** Command template with {input} and optionally {task_file}; reads task JSON on stdin-adjacent file. */
  readonly command?: string;
  readonly http?: { readonly url: string; readonly method?: string; readonly headers?: Record<string, string> };
  /** Inline deterministic transform, e.g. "echo" | "upper" — for local reproducible examples. */
  readonly inline?: string;
  readonly env?: Record<string, string>;
  readonly timeout_ms?: number;
}

export interface EvaluatorSpec {
  readonly type: "exact" | "regex" | "json_schema" | "javascript" | "command" | "llm_command" | "human" | "oracle" | "composite" | "pass_through" | "classification" | "retrieval" | "trajectory" | "refusal";
  readonly field?: string;
  readonly pattern?: string;
  readonly schema?: Record<string, unknown>;
  readonly script?: string;
  readonly command?: string;
  readonly model?: string;
  readonly rubric?: string;
  readonly judgments?: string;
  readonly evaluators?: readonly EvaluatorSpec[];
  readonly mode?: "all" | "any";
  /** human: optional second judgments file for inter-rater agreement (κ). */
  readonly judgments_secondary?: string;
  /** regex: pass when the pattern is ABSENT (injection-marker resistance). */
  readonly invert?: boolean;
  /** classification: the positive class (string/boolean/number). Required for binary precision/recall. */
  readonly positive?: unknown;
  /** classification: output object field holding a numeric score in [0,1] (for ROC-AUC, PR-AUC, calibration). */
  readonly scoreField?: string;
  /** trajectory: scope rules (per-task constraints override per key). */
  readonly rules?: TrajectoryRules;
}

export interface TrajectoryRules {
  readonly allowed_tools?: readonly string[];
  readonly forbidden_tools?: readonly string[];
  readonly forbidden_targets?: readonly string[];
  readonly forbidden_patterns?: readonly string[];
  readonly max_steps?: number;
}

export class SpecError extends Error {
  override readonly name = "SpecError";
}

export function loadSpecFile(path: string): EvalSpec {
  const raw = readFileSync(path, "utf8");
  return parseSpec(raw, path);
}

export function parseSpec(raw: string, sourceName = "<inline>"): EvalSpec {
  const trimmed = raw.trim();
  let data: unknown;
  if (trimmed.startsWith("{")) {
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      throw new SpecError(`${sourceName}: invalid JSON: ${(error as Error).message}`);
    }
  } else {
    data = parseYamlSubset(trimmed, sourceName);
  }
  return validateSpec(data, sourceName);
}

export function validateSpec(raw: unknown, sourceName = "<inline>"): EvalSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SpecError(`${sourceName}: spec must be an object`);
  const s = raw as Record<string, unknown>;
  const name = typeof s.name === "string" && s.name ? (s.name as string) : "evaluation";
  const dataset = (s.dataset ?? {}) as Record<string, unknown>;
  const subject = s.subject as Record<string, unknown> | undefined;
  const isBenchmark = s.benchmark !== undefined && typeof s.benchmark === "object";
  if ((!subject || typeof subject !== "object") && !isBenchmark) {
    throw new SpecError(`${sourceName}: spec.subject is required (benchmarks declare it via --subject at run time)`);
  }
  if (subject && typeof subject === "object") validateSubjectSpec(subject as Record<string, unknown>, `${sourceName}: spec.subject`);
  if (s.baseline !== undefined) {
    if (!s.baseline || typeof s.baseline !== "object") throw new SpecError(`${sourceName}: spec.baseline must be an object`);
    validateSubjectSpec(s.baseline as Record<string, unknown>, `${sourceName}: spec.baseline`);
  }
  if (s.ablations !== undefined) {
    if (!Array.isArray(s.ablations)) throw new SpecError(`${sourceName}: spec.ablations must be an array`);
    for (const [i, abl] of (s.ablations as unknown[]).entries()) {
      if (!abl || typeof abl !== "object") throw new SpecError(`${sourceName}: spec.ablations[${i}] must be an object`);
      const a = abl as Record<string, unknown>;
      if (typeof a.name !== "string" || !a.name) throw new SpecError(`${sourceName}: spec.ablations[${i}].name must be a nonempty string`);
      if (!a.subject || typeof a.subject !== "object") throw new SpecError(`${sourceName}: spec.ablations[${i}].subject is required`);
      validateSubjectSpec(a.subject as Record<string, unknown>, `${sourceName}: spec.ablations[${i}].subject`);
    }
  }
  validateDatasetSpec(dataset, sourceName);
  const evaluator = s.evaluator as Record<string, unknown> | undefined;
  if (!evaluator || typeof evaluator !== "object") throw new SpecError(`${sourceName}: spec.evaluator is required`);
  validateEvaluatorSpec(evaluator, `${sourceName}: spec.evaluator`);

  let claim: Claim | undefined;
  const claimRaw = s.claim;
  if (claimRaw !== undefined) {
    const { claim: c, problems } = validateClaim(claimRaw);
    if (problems.length > 0) throw new SpecError(`${sourceName}: invalid claim: ${problems.join("; ")}`);
    claim = c;
  }

  const repetitions = s.repetitions;
  if (repetitions !== undefined && (!Number.isInteger(repetitions) || (repetitions as number) < 1)) {
    throw new SpecError(`${sourceName}: repetitions must be an integer >= 1`);
  }
  if (s.seeds !== undefined) {
    if (!Array.isArray(s.seeds) || s.seeds.length === 0) {
      throw new SpecError(`${sourceName}: seeds must be a nonempty array`);
    }
    for (const seed of s.seeds as unknown[]) {
      if (typeof seed !== "number" && typeof seed !== "string") {
        throw new SpecError(`${sourceName}: seeds must contain only numbers/strings`);
      }
    }
  }
  if (s.timeout_ms !== undefined && (typeof s.timeout_ms !== "number" || !Number.isFinite(s.timeout_ms) || (s.timeout_ms as number) < 0)) {
    throw new SpecError(`${sourceName}: timeout_ms must be a finite number >= 0`);
  }
  if (s.metrics !== undefined) {
    if (!Array.isArray(s.metrics)) throw new SpecError(`${sourceName}: metrics must be an array of strings`);
    for (const m of s.metrics as unknown[]) {
      if (typeof m !== "string" || !m) throw new SpecError(`${sourceName}: metrics must be nonempty strings`);
    }
  }
  if (s.thresholds !== undefined) {
    if (!s.thresholds || typeof s.thresholds !== "object" || Array.isArray(s.thresholds)) {
      throw new SpecError(`${sourceName}: thresholds must be an object`);
    }
    for (const [k, v] of Object.entries(s.thresholds as Record<string, unknown>)) {
      if (typeof v !== "string" || !/^(>=|<=|>|<|==|!=)\s*-?\d+(\.\d+)?$/.test(v.trim())) {
        throw new SpecError(`${sourceName}: thresholds["${k}"] must look like ">= 0.8"`);
      }
    }
  }
  if (s.sanity_threshold !== undefined && (typeof s.sanity_threshold !== "number" || !Number.isFinite(s.sanity_threshold))) {
    throw new SpecError(`${sourceName}: sanity_threshold must be a finite number`);
  }

  const maxTurns = s.max_turns;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || (maxTurns as number) < 1)) {
    throw new SpecError(`${sourceName}: max_turns must be an integer >= 1`);
  }

  return {
    name,
    ...(claim ? { claim } : {}),
    ...(typeof s.claim_ref === "string" ? { claim_ref: s.claim_ref as string } : {}),
    ...(isBenchmark ? { benchmark: s.benchmark as EvalSpec["benchmark"] } : {}),
    dataset: {
      ...(typeof dataset.path === "string" ? { path: dataset.path as string } : {}),
      ...(Array.isArray(dataset.inline) ? { inline: dataset.inline as unknown[] } : {}),
      ...(dataset.stdin === true ? { stdin: true } : {}),
      ...(typeof dataset.format === "string" ? { format: dataset.format as EvalSpec["dataset"]["format"] } : {}),
      ...(typeof dataset.id === "string" ? { id: dataset.id as string } : {}),
      ...(typeof dataset.version === "string" ? { version: dataset.version as string } : {}),
    },
    subject: subject as unknown as SubjectSpec | undefined,
    ...((s.baseline as object) ? { baseline: s.baseline as SubjectSpec } : {}),
    ...(Array.isArray(s.ablations) ? { ablations: s.ablations as EvalSpec["ablations"] } : {}),
    evaluator: evaluator as unknown as EvaluatorSpec,
    ...(Array.isArray(s.metrics) ? { metrics: s.metrics as string[] } : {}),
    ...(repetitions !== undefined ? { repetitions: repetitions as number } : {}),
    ...(maxTurns !== undefined ? { max_turns: maxTurns as number } : {}),
    ...(Array.isArray(s.seeds) ? { seeds: s.seeds as (number | string)[] } : {}),
    ...(typeof s.paired === "boolean" ? { paired: s.paired as boolean } : {}),
    ...(typeof s.timeout_ms === "number" ? { timeout_ms: s.timeout_ms as number } : {}),
    ...((s.thresholds as object) ? { thresholds: s.thresholds as Record<string, string> } : {}),
    ...((s.regression as object) ? { regression: s.regression as EvalSpec["regression"] } : {}),
    ...((s.gate as object) ? { gate: s.gate as EvalSpec["gate"] } : {}),
    ...(s.sanity_baseline === true ? { sanity_baseline: true } : {}),
    ...(typeof s.sanity_threshold === "number" ? { sanity_threshold: s.sanity_threshold as number } : {}),
    ...(Array.isArray(s.analysis) ? { analysis: s.analysis as string[] } : {}),
    ...((s.output as object) ? { output: s.output as EvalSpec["output"] } : {}),
  };
}

const EVALUATOR_TYPES = new Set([
  "exact", "regex", "json_schema", "javascript", "command", "llm_command",
  "human", "oracle", "composite", "pass_through", "classification",
  "retrieval", "trajectory", "refusal",
]);

const DATASET_FORMATS = new Set(["json", "jsonl", "csv", "yaml", "text", "dir", "auto"]);

function validateSubjectSpec(s: Record<string, unknown>, where: string): void {
  const transports = ["command", "http", "inline"].filter((k) => s[k] !== undefined);
  if (transports.length === 0) throw new SpecError(`${where}: one of command, http, or inline is required`);
  if (transports.length > 1) throw new SpecError(`${where}: exactly one subject transport is required (got ${transports.join(", ")})`);
  if (s.command !== undefined && typeof s.command !== "string") throw new SpecError(`${where}.command must be a string`);
  if (s.inline !== undefined && typeof s.inline !== "string") throw new SpecError(`${where}.inline must be a string`);
  if (s.http !== undefined) {
    if (!s.http || typeof s.http !== "object") throw new SpecError(`${where}.http must be an object`);
    const h = s.http as Record<string, unknown>;
    if (typeof h.url !== "string" || !h.url) throw new SpecError(`${where}.http.url must be a nonempty string`);
  }
  if (s.timeout_ms !== undefined && (typeof s.timeout_ms !== "number" || !Number.isFinite(s.timeout_ms) || (s.timeout_ms as number) < 0)) {
    throw new SpecError(`${where}.timeout_ms must be a finite number >= 0`);
  }
}

function validateDatasetSpec(d: Record<string, unknown>, sourceName: string): void {
  const sources = ["path", "inline", "stdin"].filter((k) => d[k] !== undefined && d[k] !== false);
  if (sources.length === 0) throw new SpecError(`${sourceName}: dataset needs one of path, inline, or stdin:true`);
  if (sources.length > 1) throw new SpecError(`${sourceName}: dataset sources are exclusive (got ${sources.join(", ")})`);
  if (d.format !== undefined && (typeof d.format !== "string" || !DATASET_FORMATS.has(d.format as string))) {
    throw new SpecError(`${sourceName}: dataset.format must be one of ${[...DATASET_FORMATS].join(", ")}`);
  }
}

function validateEvaluatorSpec(e: Record<string, unknown>, where: string): void {
  if (typeof e.type !== "string") throw new SpecError(`${where}.type is required`);
  if (!EVALUATOR_TYPES.has(e.type as string)) throw new SpecError(`${where}.type must be one of ${[...EVALUATOR_TYPES].join(", ")}`);
  const need = (field: string) => {
    if (e[field] === undefined) throw new SpecError(`${where}: evaluator ${e.type} requires "${field}"`);
  };
  switch (e.type as string) {
    case "regex":
      need("pattern");
      break;
    case "json_schema":
      need("schema");
      break;
    case "javascript":
      need("script");
      break;
    case "command":
    case "oracle":
    case "llm_command":
      need("command");
      break;
    case "human":
      need("judgments");
      break;
    case "composite": {
      if (!Array.isArray(e.evaluators) || (e.evaluators as unknown[]).length === 0) {
        throw new SpecError(`${where}: evaluator composite requires nonempty evaluators[]`);
      }
      for (const [i, sub] of (e.evaluators as Record<string, unknown>[]).entries()) {
        if (!sub || typeof sub !== "object") throw new SpecError(`${where}.evaluators[${i}] must be an object`);
        validateEvaluatorSpec(sub as Record<string, unknown>, `${where}.evaluators[${i}]`);
      }
      if (e.mode !== undefined && e.mode !== "all" && e.mode !== "any") {
        throw new SpecError(`${where}.mode must be "all" or "any"`);
      }
      break;
    }
    case "trajectory":
      break;
    default:
      break;
  }
}

/**
 * Minimal YAML-subset parser: top-level `key: value` + nested maps/lists by
 * indentation, scalars (string/number/boolean), `|`/`>` blocks. Sufficient for
 * Genesis evaluation specs without adding a dependency.
 */
function parseYamlSubset(text: string, sourceName: string): unknown {
  const lines = text.split(/\r?\n/);
  // Fast path: flat mapping only.
  try {
    const root: Record<string, unknown> = {};
    const stack: { indent: number; container: Record<string, unknown> | unknown[]; key?: string }[] = [
      { indent: -1, container: root },
    ];
    let i = 0;
    let blockKey: { target: Record<string, unknown>; key: string; indent: number; style: string } | null = null;
    while (i < lines.length) {
      const line = lines[i] as string;
      const next = nextLine(lines, i);
      i++;
      if (/^\s*(#|$)/.test(line)) continue;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      const content = line.slice(indent);
      if (blockKey && (content === "" || indent > blockKey.indent)) {
        const t = blockKey.target[blockKey.key];
        (blockKey.target[blockKey.key] as string) = `${(t as string) ?? ""}${content}\n`;
        continue;
      } else blockKey = null;
      if (content.startsWith("- ")) {
        const parent = stack[stack.length - 1];
        if (!parent) throw new Error("bad list");
        const arr = ensureList(stack);
        const itemText = content.slice(2).trim();
        if (itemText === "") {
          const child: Record<string, unknown> = {};
          arr.push(child);
          stack.push({ indent, container: child });
        } else if (itemText.includes(":") && !itemText.startsWith('"') && !itemText.startsWith("'")) {
          const child: Record<string, unknown> = {};
          arr.push(child);
          stack.push({ indent, container: child });
          parseInlineMap(itemText, child);
        } else {
          arr.push(parseScalar(itemText));
        }
        continue;
      }
      const m = content.match(/^([^:#\s][^:]*):\s*(.*)$/);
      if (!m) throw new Error(`unparseable line: ${line}`);
      const key = (m[1] as string).trim();
      let value = (m[2] as string).trim();
      // Pop stack to correct parent.
      while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop();
      const parent = stack[stack.length - 1]?.container as Record<string, unknown>;
      // Strip trailing comments for scalars.
      value = stripComment(value);
      if (value === "|" || value === ">") {
        parent[key] = "";
        blockKey = { target: parent, key, indent, style: value };
      } else if (value === "") {
        // Nested block: peek — list or map.
        if (next && next.indent > indent && next.content.startsWith("- ")) {
          const arr: unknown[] = [];
          parent[key] = arr;
          stack.push({ indent, container: arr });
        } else {
          const child: Record<string, unknown> = {};
          parent[key] = child;
          stack.push({ indent, container: child });
        }
      } else {
        parent[key] = parseScalar(value);
      }
    }
    return root;
  } catch (error) {
    throw new SpecError(`${sourceName}: could not parse YAML-subset: ${(error as Error).message}`);
  }
}

function nextLine(lines: string[], i: number): { indent: number; content: string } | null {
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j] as string;
    if (/^\s*(#|$)/.test(l)) continue;
    const indent = l.match(/^ */)?.[0].length ?? 0;
    return { indent, content: l.slice(indent) };
  }
  return null;
}

function ensureList(stack: { indent: number; container: Record<string, unknown> | unknown[]; key?: string }[]): unknown[] {
  const top = stack[stack.length - 1];
  if (!top) throw new Error("bad stack");
  if (Array.isArray(top.container)) return top.container;
  throw new Error("list item without list parent");
}

function parseInlineMap(itemText: string, child: Record<string, unknown>): void {
  const m = itemText.match(/^([^:]+):\s*(.*)$/);
  if (m) {
    child[(m[1] as string).trim()] = parseScalar(stripComment((m[2] as string).trim()));
  }
}

function stripComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v;
  const idx = v.indexOf(" #");
  return idx >= 0 ? v.slice(0, idx).trim() : v;
}

function parseScalar(v: string): unknown {
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  const sq = v.match(/^'(.*)'$/s);
  if (sq) return sq[1];
  const dq = v.match(/^"(.*)"$/s);
  if (dq) {
    try {
      return JSON.parse(v);
    } catch {
      return dq[1];
    }
  }
  if ((v.startsWith("[") && v.endsWith("]")) || (v.startsWith("{") && v.endsWith("}"))) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
