/**
 * Static HTML reports + prompt-injection resistance.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadBenchmark, resolveBenchmarkDataset } from "../src/eval/benchmarks.js";
import { buildManifest, writeEvidenceBundle } from "../src/eval/bundle.js";
import { createEvaluator } from "../src/eval/evaluators.js";
import { renderHtmlFromBundle, renderHtmlReport } from "../src/eval/report-html.js";
import { runExperiment } from "../src/eval/runner.js";
import { loadSpecFile } from "../src/eval/spec.js";

describe("html reports", () => {
  it("escapes hostile trial output instead of rendering it", async () => {
    const result = await runExperiment({
      name: "xss",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "echo" },
      evaluator: { type: "javascript", script: "return true;" },
      metrics: ["task_success"],
    });
    // Inject hostile content post-hoc (simulates a malicious subject log).
    const hostile = {
      ...result,
      arms: result.arms.map((a) => ({
        ...a,
        trials: a.trials.map((t) => ({ ...t, output: '<script>alert("pwned")</script><b>bold</b>' })),
      })),
    };
    const html = renderHtmlReport(hostile);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Genesis evidence report");
  });

  it("covers verdict, metrics, findings, and trials", async () => {
    const result = await runExperiment(loadSpecFile("examples/arithmetic/evaluation.yaml"));
    const html = renderHtmlReport(result);
    expect(html).toContain("SUPPORTED");
    expect(html).toContain("task_success");
    expect(html).toContain("Trials (");
    expect(html).toContain("filterTrials");
    expect(html).toContain("DOCTYPE html");
  }, 120_000);

  it("bundles ship report.html and regenerate identically from disk", async () => {
    const result = await runExperiment(loadSpecFile("examples/arithmetic/evaluation.yaml"));
    const dir = mkdtempSync(join(tmpdir(), "genesis-html-"));
    try {
      const spec = loadSpecFile("examples/arithmetic/evaluation.yaml");
      writeEvidenceBundle(dir, spec, result, buildManifest(spec, result));
      expect(existsSync(join(dir, "report.html"))).toBe(true);
      const regen = renderHtmlFromBundle(dir);
      expect(regen).toContain("SUPPORTED");
      expect(regen).toContain("task_success");
      const onDisk = readFileSync(join(dir, "report.html"), "utf8");
      expect(onDisk).toContain("SUPPORTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("prompt-injection resistance", () => {
  it("inverted regex passes on absence, fails on presence", async () => {
    const e = createEvaluator({ type: "regex", pattern: "PWNED", invert: true });
    expect((await e.evaluate({ id: "t", input: "x" }, "clean answer")).passed).toBe(true);
    expect((await e.evaluate({ id: "t", input: "x" }, "here is PWNED")).passed).toBe(false);
    const plain = createEvaluator({ type: "regex", pattern: "PWNED" });
    expect((await plain.evaluate({ id: "t", input: "x" }, "clean")).passed).toBe(false);
  });

  it("injection-shield: candidate resists, echo baseline complies", async () => {
    const result = await runExperiment(loadSpecFile("examples/injection-shield/evaluation.yaml"));
    expect(result.verdict.verdict).toBe("SUPPORTED");
    const get = (arm: string) =>
      result.arms.find((a) => a.arm === arm)?.metrics.find((m) => m.metric === "task_success")?.value;
    expect(get("treatment")).toBe(1);
    expect(get("baseline")).toBe(0);
  }, 120_000);

  it("prompt-injection-v1 benchmark: registry loads and gates", async () => {
    const { spec } = loadBenchmark("prompt-injection-v1", join(process.cwd(), "benchmarks"));
    const resolved = resolveBenchmarkDataset(spec, join(process.cwd(), "benchmarks", "prompt-injection-v1"));
    const result = await runExperiment({
      ...resolved,
      subject: { command: "node ./examples/injection-shield/candidate.mjs {task_file}" },
    });
    expect(result.verdict.verdict).toBe("SUPPORTED");
  }, 120_000);
});
