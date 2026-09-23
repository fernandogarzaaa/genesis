/**
 * Reproducibility manifest + exportable evidence bundle.
 *
 * experiment/
 * ├── manifest.json      — genesis version, spec/dataset digests, env, seeds
 * ├── claim.json         — the claim (if any)
 * ├── specification.json — the evaluation spec (redacted)
 * ├── dataset.json       — dataset identity + schema
 * ├── baseline/          — results.jsonl + metrics.json (when present)
 * ├── treatment/         — results.jsonl + metrics.json
 * ├── ablations/         — per-arm results (when present)
 * ├── statistics.json    — per-arm stats + paired comparisons
 * ├── findings.json
 * ├── evidence/          — evidence.jsonl (every record, digested)
 * └── verdict.json       — verdict with claim boundaries
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, hashCanonicalExcluding } from "../shared/canonical.js";
import { redact, redactDeep } from "../shared/redact.js";
import { computeEnvDigest } from "../evidence/runner.js";
import type { ExperimentResult } from "./runner.js";
import type { EvalSpec } from "./spec.js";

export const GENESIS_VERSION = "0.3.0";
export const BUNDLE_DIGEST_VERSION = 2;

export interface Manifest {
  readonly genesis_version: string;
  readonly created_at: string;
  readonly spec_digest: string;
  readonly dataset_digest: string;
  readonly env_digest: string;
  readonly runtime: Record<string, unknown>;
  readonly seeds: readonly (number | string)[];
  readonly repetitions: number;
  readonly ledger_entry: string | null;
}

export function buildManifest(
  spec: EvalSpec,
  result: ExperimentResult,
  options: { ledgerEntry?: string | null; repoPath?: string } = {},
): Manifest {
  return {
    genesis_version: GENESIS_VERSION,
    created_at: new Date().toISOString(),
    spec_digest: result.spec_digest,
    dataset_digest: result.dataset.digest,
    env_digest: computeEnvDigest(options.repoPath ?? process.cwd()),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    seeds: spec.seeds ?? spec.claim?.methodology?.seeds ?? [1],
    repetitions: spec.repetitions ?? spec.claim?.methodology?.repetitions ?? 1,
    ledger_entry: options.ledgerEntry ?? null,
  };
}

export function writeEvidenceBundle(
  dir: string,
  spec: EvalSpec,
  result: ExperimentResult,
  manifest: Manifest,
  options: { allowRawAnalysis?: boolean } = {},
): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "evidence"), { recursive: true });
  // Deep-redact structured values BEFORE serialization so header names like
  // `Authorization` and nested credential fields never survive (string-level
  // redaction on serialized JSON misses them).
  const write = (rel: string, value: unknown) => {
    const text = JSON.stringify(redactDeep(value), null, 2);
    writeFileSync(join(dir, rel), text, "utf8");
  };
  write("manifest.json", manifest);
  if (spec.claim) write("claim.json", spec.claim);
  write("specification.json", { ...spec, spec_digest: result.spec_digest });
  write("dataset.json", result.dataset);
  for (const arm of result.arms) {
    const armDir = arm.arm === "treatment"
      ? "treatment"
      : arm.arm === "baseline"
        ? "baseline"
        : join("ablations", arm.arm.replace(/^(ablation|sanity):/, "").replace(/[^A-Za-z0-9._-]+/g, "_"));
    mkdirSync(join(dir, armDir), { recursive: true });
    const lines = arm.trials.map((t) => {
      const obs = arm.observations.find((o) => o.trial_id === t.trial_id);
      return JSON.stringify(redactDeep({ trial: t, observation: obs }));
    });
    writeFileSync(join(dir, armDir, "results.jsonl"), `${lines.join("\n")}\n`, "utf8");
    write(join(armDir, "metrics.json"), arm.metrics);
  }
  write("statistics.json", {
    arms: result.arms.map((a) => ({ arm: a.arm, statistics: a.statistics })),
    comparisons: result.comparisons,
  });
  write("findings.json", result.findings);
  const evidenceLines = result.arms.flatMap((a) => a.evidence).map((e) => JSON.stringify(redactDeep(e)));
  writeFileSync(join(dir, "evidence", "evidence.jsonl"), `${evidenceLines.join("\n")}\n`, "utf8");
  write("verdict.json", result.verdict);
  if (spec.analysis && spec.analysis.length > 0) {
    // Analysis attachments are NOT copied verbatim anymore: textual files are
    // scanned/redacted, binaries require explicit opt-in. Verbatim copy was a
    // secret-leak path (PEM keys landed under analysis/ unredacted).
    mkdirSync(join(dir, "analysis"), { recursive: true });
    for (const file of spec.analysis) {
      let content: Buffer;
      try {
        content = readFileSync(file);
      } catch {
        throw new Error(`analysis attachment not found: ${file}`);
      }
      const base = file.split(/[\\/]/).pop() as string;
      const out = sanitizeAttachment(content, base, options.allowRawAnalysis ?? false);
      writeFileSync(join(dir, "analysis", base), out);
    }
  }
  // Bundle digest v2 covers the complete tree (verdict + manifest + spec +
  // dataset + arms + evidence + findings + statistics), excluding only DIGEST
  // itself. Legacy verdict-only digest is preserved for historic verification.
  const legacyDigest = createHash("sha256").update(canonicalize(result.verdict as unknown as Record<string, unknown>)).digest("hex");
  const tree = collectBundleTree(dir);
  const bundleDigest = hashCanonicalExcluding(
    { version: BUNDLE_DIGEST_VERSION, files: tree } as unknown as Record<string, unknown>,
    [],
  );
  writeFileSync(join(dir, "DIGEST"), `sha256:${bundleDigest}\n`, "utf8");
  writeFileSync(join(dir, "DIGEST.legacy"), `sha256:${legacyDigest}\n`, "utf8");
}

/** Redact/sanitize a single analysis attachment. */
function sanitizeAttachment(content: Buffer, base: string, allowRaw: boolean): Buffer | string {
  if (isProbablyText(content)) {
    return redact(content.toString("utf8"));
  }
  if (!allowRaw) {
    throw new Error(
      `analysis attachment "${base}" looks binary; refusing verbatim copy (secret-leak path). ` +
        `Pass allowRawAnalysis to opt in, or attach a redacted text note instead.`,
    );
  }
  return content;
}

function isProbablyText(content: Buffer): boolean {
  if (content.length === 0) return true;
  const sample = content.subarray(0, Math.min(content.length, 8000));
  // NUL byte or high control-char density → binary.
  let controls = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) controls++;
  }
  return controls / sample.length < 0.05;
}

/** Hash every file in the bundle tree (sorted, sha256 per file). */
function collectBundleTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const full = join(dir, rel);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(full).sort()) walk(rel ? `${rel}/${e}` : e);
    } else if (st.isFile()) {
      if (rel === "DIGEST" || rel === "DIGEST.legacy") return;
      out[rel] = `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
  };
  walk("");
  return out;
}

/** Verify an unsigned bundle: recompute v2 tree digest (+ legacy) and compare. */
export function verifyEvidenceBundle(dir: string): {
  readonly ok: boolean;
  readonly digest: string;
  readonly legacyDigest: string;
  readonly expected: string;
  readonly legacyExpected: string | null;
} {
  const tree = collectBundleTree(dir);
  const digest = hashCanonicalExcluding(
    { version: BUNDLE_DIGEST_VERSION, files: tree } as unknown as Record<string, unknown>,
    [],
  );
  let expected = "";
  try {
    expected = readFileSync(join(dir, "DIGEST"), "utf8").trim();
  } catch {
    expected = "";
  }
  let legacyExpected: string | null = null;
  try {
    legacyExpected = readFileSync(join(dir, "DIGEST.legacy"), "utf8").trim();
  } catch {
    legacyExpected = null;
  }
  let legacyDigest = "";
  try {
    const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8"));
    legacyDigest = `sha256:${createHash("sha256").update(canonicalize(verdict)).digest("hex")}`;
  } catch {
    legacyDigest = "";
  }
  return { ok: expected === `sha256:${digest}`, digest: `sha256:${digest}`, legacyDigest, expected, legacyExpected };
}

export function readEvidenceBundle(dir: string): { verdict: unknown; manifest: unknown; metrics: unknown } {  return {
    verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")),
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    metrics: tryRead(join(dir, "treatment", "metrics.json")),
  };
}

function tryRead(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Trust bundle: the evaluation evidence bundle plus evaluator assurance.
 *
 * <dir>/evaluation/...   (standard evidence bundle)
 * <dir>/assurance.json   (dataset-derived probes + optional suite audit)
 * <dir>/trust.json       (combined TRUSTED | UNTRUSTED | INCONCLUSIVE)
 * <dir>/gate.json        (release-gate decision, when `genesis gate` ran)
 */
export function writeTrustBundle(
  dir: string,
  spec: EvalSpec,
  result: ExperimentResult,
  manifest: Manifest,
  assurance: unknown,
  trust: unknown,
  gate?: unknown,
  options: { allowRawAnalysis?: boolean } = {},
): void {
  writeEvidenceBundle(join(dir, "evaluation"), spec, result, manifest, options);
  const write = (rel: string, value: unknown) => {
    writeFileSync(join(dir, rel), JSON.stringify(redactDeep(value), null, 2), "utf8");
  };
  mkdirSync(dir, { recursive: true });
  write("assurance.json", assurance);
  write("trust.json", trust);
  if (gate !== undefined) write("gate.json", gate);
}
