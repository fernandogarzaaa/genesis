/**
 * Regression tests for genesis-full-audit findings (main branch).
 * Each test reproduces an audit finding and must fail pre-fix / pass post-fix.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExperiment, isFailedExecution, truncateOutput } from "../src/eval/runner.js";
import { createEvaluator } from "../src/eval/evaluators.js";
import { splitCommand } from "../src/eval/subjects.js";
import { redactDeep, registerSecret, clearRegisteredSecrets } from "../src/shared/redact.js";
import { buildManifest, writeEvidenceBundle, verifyEvidenceBundle, GENESIS_VERSION } from "../src/eval/bundle.js";
import { validateSpec, parseSpec } from "../src/eval/spec.js";
import { SubprocessRunner } from "../src/evidence/runner.js";
import { FakeRunner } from "./helpers.js";
import type { EvalTask } from "../src/eval/types.js";

const t = (over: Partial<EvalTask> = {}): EvalTask => ({ id: "t1", input: "hello", reference: "HELLO", ...over });

// ── High: failed subject must not produce SUPPORTED ──

describe("fail-closed execution", () => {
  it("nonzero exit with correct stdout is unjudged, not SUPPORTED", async () => {
    const runner = new FakeRunner({}, { stdout: "HELLO", stderr: "", exit_code: 1 });
    const result = await runExperiment(
      {
        name: "fail-closed",
        dataset: { inline: [{ id: "t1", input: "hello", reference: "HELLO" }] },
        subject: { command: "produce-output" },
        evaluator: { type: "exact" },
        metrics: ["task_success"],
        thresholds: { task_success: ">= 0.5" },
      },
      { runner },
    );
    const obs = result.arms[0]?.observations[0];
    expect(obs?.passed).toBeNull();
    expect(result.arms[0]?.trials[0]?.error).toContain("exit 1");
    const ts = result.arms[0]?.metrics.find((m) => m.metric === "task_success");
    expect(ts?.value).toBe(0);
    expect(result.verdict.verdict).not.toBe("SUPPORTED");
  });

  it("timed-out trial is unjudged", async () => {
    const runner = new FakeRunner({}, { stdout: "HELLO", exit_code: null, timed_out: true });
    const result = await runExperiment(
      {
        name: "timeout-closed",
        dataset: { inline: [{ id: "t1", input: "x", reference: "HELLO" }] },
        subject: { command: "slow" },
        evaluator: { type: "exact" },
        metrics: ["task_success"],
      },
      { runner },
    );
    expect(result.arms[0]?.observations[0]?.passed).toBeNull();
    expect(result.arms[0]?.observations[0]?.details).toMatchObject({ unjudged: true });
  });

  it("spawn error is unjudged", async () => {
    const runner = new FakeRunner({}, { stdout: "", exit_code: null, spawn_error: "spawn ENOENT" });
    const result = await runExperiment(
      {
        name: "spawn-closed",
        dataset: { inline: [{ id: "t1", input: "x", reference: "x" }] },
        subject: { command: "missing-bin" },
        evaluator: { type: "exact" },
        metrics: ["task_success"],
      },
      { runner },
    );
    expect(result.arms[0]?.observations[0]?.passed).toBeNull();
  });

  it("isFailedExecution gates error/timeout/nonzero exit", () => {
    expect(isFailedExecution({ error: null, timed_out: false, exit_code: 0 })).toBe(false);
    expect(isFailedExecution({ error: "exit 1", timed_out: false, exit_code: 1 })).toBe(true);
    expect(isFailedExecution({ error: null, timed_out: true, exit_code: null })).toBe(true);
    expect(isFailedExecution({ error: "boom", timed_out: false, exit_code: null })).toBe(true);
  });
});

// ── High: composite three-valued logic ──

describe("composite three-valued logic", () => {
  const taskNoRef = { id: "t1", input: "x" } as EvalTask; // exact abstains (null)
  const taskRef = { id: "t1", input: "x", reference: "x" } as EvalTask;

  it("all: true + null => null (not true)", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "all",
      evaluators: [{ type: "exact" }, { type: "regex", pattern: "x" }],
    });
    const o = await e.evaluate(taskNoRef, "x");
    expect(o.passed).toBeNull();
  });

  it("all: false + null => false", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "all",
      evaluators: [{ type: "exact" }, { type: "regex", pattern: "zzz-nomatch" }],
    });
    const o = await e.evaluate(taskNoRef, "x");
    expect(o.passed).toBe(false);
  });

  it("all: true + true => true", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "all",
      evaluators: [{ type: "exact" }, { type: "regex", pattern: "x" }],
    });
    const o = await e.evaluate(taskRef, "x");
    expect(o.passed).toBe(true);
  });

  it("any: false + null => null (not false)", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "any",
      evaluators: [{ type: "exact" }, { type: "regex", pattern: "zzz-nomatch" }],
    });
    const o = await e.evaluate(taskNoRef, "zzz");
    // exact abstains (null), regex false → any(false, null) = null
    expect(o.passed).toBeNull();
  });

  it("any: true + null => true", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "any",
      evaluators: [{ type: "exact" }, { type: "regex", pattern: "x" }],
    });
    const o = await e.evaluate(taskNoRef, "x");
    expect(o.passed).toBe(true);
  });
});

// ── Medium: quoted command parsing ──

describe("command parsing", () => {
  it("splitCommand respects quotes", () => {
    expect(splitCommand(`node -e "console.log(1)"`)).toEqual(["node", "-e", "console.log(1)"]);
    expect(splitCommand(`prog "path with spaces/x" --flag`)).toEqual(["prog", "path with spaces/x", "--flag"]);
    expect(splitCommand(`prog 'single quoted'`)).toEqual(["prog", "single quoted"]);
  });

  it("command evaluator handles quoted args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-cmd-"));
    try {
      const judge = join(dir, "judge.mjs");
      writeFileSync(judge, `console.log(JSON.stringify({passed: true}));`, "utf8");
      const e = createEvaluator(
        { type: "command", command: `node "${judge}" --label "hello world"` },
        new SubprocessRunner(),
      );
      const o = await e.evaluate(t(), "anything");
      expect(o.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Medium: large output truncation envelope ──

describe("output truncation", () => {
  it("large JSON becomes an envelope, not [object Object]", () => {
    const big = { data: "x".repeat(30000) };
    const out = truncateOutput(big) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(typeof out.excerpt).toBe("string");
    expect(out.byte_count).toBeGreaterThan(20000);
    expect(typeof out.digest).toBe("string");
    expect(String(out.excerpt)).not.toBe("[object Object]");
  });

  it("large strings become envelopes", () => {
    const out = truncateOutput("y".repeat(25000)) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
  });
});

// ── High: secret redaction ──

describe("secret redaction", () => {
  it("redacts Authorization headers by key", () => {
    const out = redactDeep({ headers: { Authorization: "Bearer abcdef1234567890", "Content-Type": "text" } });
    expect((out.headers as Record<string, unknown>).Authorization).toBe("[REDACTED]");
    expect((out.headers as Record<string, unknown>)["Content-Type"]).toBe("text");
  });

  it("redacts nested credential values", () => {
    const out = redactDeep({ a: { b: { api_key: "supersecretvalue123", ok: "fine" } } }) as Record<string, unknown>;
    expect(((out.a as Record<string, unknown>).b as Record<string, unknown>).api_key).toBe("[REDACTED]");
  });

  it("redacts registered secrets deeply", () => {
    registerSecret("my-registered-secret-123");
    try {
      const out = redactDeep({ nested: ["prefix-my-registered-secret-123-suffix"] });
      expect(JSON.stringify(out)).not.toContain("my-registered-secret-123");
    } finally {
      clearRegisteredSecrets();
    }
  });
});

// ── Bundle integrity ──

describe("bundle integrity", () => {
  it("evidence digests bind the full record and verify round-trips", async () => {
    const result = await runExperiment({
      name: "digest-test",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const ev = result.arms[0]?.evidence[0];
    expect(ev?.trial).toBeDefined();
    expect(ev?.legacy_digest).toBeDefined();
    // Tampering with the trial output must change the digest.
    const { hashCanonicalExcluding } = await import("../src/shared/canonical.js");
    const body = { ...(ev as unknown as Record<string, unknown>) };
    delete (body as Record<string, unknown>).digest;
    const before = (ev as { digest: string }).digest;
    (body as Record<string, unknown>).trial = { ...((body as Record<string, unknown>).trial as object), output: "TAMPERED" };
    const after = hashCanonicalExcluding(body as Record<string, unknown>, ["digest"]);
    expect(after).not.toBe(before);
  });

  it("writeEvidenceBundle deep-redacts Authorization + verifies", async () => {
    const result = await runExperiment({
      name: "redact-bundle",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-secure-"));
    try {
      const spec = {
        name: "redact-bundle",
        dataset: {},
        subject: { inline: "upper", env: { Authorization: "Bearer should-not-leak-1234567890" } },
        evaluator: { type: "exact" },
      } as Parameters<typeof writeEvidenceBundle>[1];
      const manifest = buildManifest(spec, result);
      writeEvidenceBundle(dir, spec, result, manifest);
      const specText = readFileSync(join(dir, "specification.json"), "utf8");
      expect(specText).not.toContain("should-not-leak-1234567890");
      expect(specText).toContain("[REDACTED]");
      const v = verifyEvidenceBundle(dir);
      expect(v.ok).toBe(true);
      expect(existsSync(join(dir, "DIGEST.legacy"))).toBe(true);
      // Tamper → verification fails.
      writeFileSync(join(dir, "verdict.json"), JSON.stringify({ tampered: true }), "utf8");
      expect(verifyEvidenceBundle(dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binary analysis attachments require opt-in", async () => {
    const result = await runExperiment({
      name: "attach",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-attach-"));
    const binDir = mkdtempSync(join(tmpdir(), "genesis-bin-"));
    try {
      const bin = join(binDir, "blob.bin");
      writeFileSync(bin, Buffer.from([0, 1, 2, 3, 0, 255, 254]));
      const spec = {
        name: "attach",
        dataset: {},
        subject: { inline: "upper" },
        evaluator: { type: "exact" },
        analysis: [bin],
      } as unknown as Parameters<typeof writeEvidenceBundle>[1];
      const manifest = buildManifest(spec, result);
      expect(() => writeEvidenceBundle(join(dir, "a"), spec, result, manifest)).toThrow(/opt in/i);
      writeEvidenceBundle(join(dir, "b"), spec, result, manifest, { allowRawAnalysis: true });
      expect(existsSync(join(dir, "b", "analysis", "blob.bin"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("genesis version bumped for breaking digest change", () => {
    expect(GENESIS_VERSION).toBe("0.3.0");
  });
});

// ── Spec validation ──

describe("spec validation", () => {
  it("rejects dual transports, bad evaluator types, bad thresholds", () => {
    expect(() =>
      validateSpec({ name: "x", dataset: { inline: [{ input: "a" }] }, subject: { command: "a", inline: "upper" }, evaluator: { type: "exact" } }, "t"),
    ).toThrow(/exactly one/);
    expect(() =>
      validateSpec({ name: "x", dataset: { inline: [{ input: "a" }] }, subject: { inline: "upper" }, evaluator: { type: "nope" } }, "t"),
    ).toThrow(/must be one of/);
    expect(() =>
      validateSpec(
        { name: "x", dataset: { inline: [{ input: "a" }] }, subject: { inline: "upper" }, evaluator: { type: "exact" }, thresholds: { m: "garbage" } },
        "t",
      ),
    ).toThrow(/thresholds/);
    expect(() =>
      validateSpec(
        { name: "x", dataset: { path: "a", inline: [{ input: "a" }] }, subject: { inline: "upper" }, evaluator: { type: "exact" } },
        "t",
      ),
    ).toThrow(/exclusive/);
    expect(() =>
      validateSpec({ name: "x", dataset: { inline: [{ input: "a" }] }, subject: { inline: "upper" }, evaluator: { type: "composite", evaluators: [] } }, "t"),
    ).toThrow(/nonempty/);
  });

  it("accepts a valid spec", () => {
    const s = parseSpec(
      JSON.stringify({
        name: "ok",
        dataset: { inline: [{ input: "a" }] },
        subject: { inline: "upper" },
        evaluator: { type: "composite", mode: "all", evaluators: [{ type: "exact" }, { type: "regex", pattern: "A" }] },
        seeds: [1, 2],
        timeout_ms: 1000,
        metrics: ["task_success"],
        thresholds: { task_success: ">= 0.5" },
      }),
    );
    expect(s.name).toBe("ok");
  });
});

// ── Subprocess limits ──

describe("subprocess limits", () => {
  it("caps stdout and reports output_limited", async () => {
    const r = new SubprocessRunner();
    const res = await r.run(["node", "-e", "process.stdout.write('x'.repeat(3*1024*1024))"], {
      cwd: process.cwd(),
      timeoutMs: 15000,
      maxBytes: 1024,
    });
    expect(res.output_limited).toBe(true);
    expect(res.stdout.length).toBeLessThanOrEqual(1100);
    expect(res.spawn_error).toMatch(/byte limit/);
  }, 20000);
});
