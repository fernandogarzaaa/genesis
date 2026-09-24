/**
 * Regression tests for PR #10 audit findings (rebased onto fixed main).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExperiment } from "../src/eval/runner.js";
import { fleissKappa } from "../src/eval/agreement.js";
import { buildManifest, writeEvidenceBundle } from "../src/eval/bundle.js";
import { renderHtmlFromBundle } from "../src/eval/report-html.js";
import { loadBenchmark, resolveBenchmarkDataset } from "../src/eval/benchmarks.js";
import type { Runner, RunResult, RunOptions } from "../src/evidence/runner.js";

/** Runner that fails the second multi-turn invocation, succeeds the first. */
class FailSecondTurnRunner implements Runner {
  async run(command: readonly string[], options: RunOptions): Promise<RunResult> {
    void options;
    const base = {
      command, started_at: "", ended_at: "", timed_out: false, spawn_error: null,
    } as const;
    // Turn tasks carry `#turnN` in the task file argument; read it back.
    const taskFile = command[command.length - 1] as string;
    let id = "";
    try {
      id = JSON.parse(readFileSync(taskFile, "utf8")).id ?? "";
    } catch {
      id = "";
    }
    if (id.includes("#turn2")) {
      return { ...base, exit_code: 1, stdout: "should never be scored", stderr: "" };
    }
    return { ...base, exit_code: 0, stdout: "good answer", stderr: "" };
  }
}

describe("prompt-injection benchmark is not reward-gameable", () => {
  it("empty output scores 0 (task correctness required)", async () => {
    const { spec } = loadBenchmark("prompt-injection-v1", join(process.cwd(), "benchmarks"));
    const resolved = resolveBenchmarkDataset(spec, join(process.cwd(), "benchmarks", "prompt-injection-v1"));
    const result = await runExperiment({ ...resolved, subject: { inline: "empty" } });
    const ts = result.arms[0]?.metrics.find((m) => m.metric === "task_success");
    expect(ts?.value).toBe(0);
    expect(result.verdict.verdict).not.toBe("SUPPORTED");
  });

  it("random output scores 0", async () => {
    const { spec } = loadBenchmark("prompt-injection-v1", join(process.cwd(), "benchmarks"));
    const resolved = resolveBenchmarkDataset(spec, join(process.cwd(), "benchmarks", "prompt-injection-v1"));
    const result = await runExperiment({ ...resolved, subject: { inline: "random" } });
    const ts = result.arms[0]?.metrics.find((m) => m.metric === "task_success");
    expect(ts?.value).toBe(0);
  });
});

describe("multi-turn failures withhold stale answers", () => {
  it("turn1 success + turn2 failure is unjudged", async () => {
    const result = await runExperiment(
      {
        name: "multiturn-stale",
        dataset: {
          inline: [
            {
              id: "m1",
              input: "start",
              reference: "good answer",
              turns: ["first question", "second question"],
            },
          ],
        },
        subject: { command: "answer-turns" },
        evaluator: { type: "exact" },
        metrics: ["task_success"],
      },
      { runner: new FailSecondTurnRunner() },
    );
    const trial = result.arms[0]?.trials[0];
    const obs = result.arms[0]?.observations[0];
    expect(trial?.error).toBeTruthy();
    expect(trial?.output).toBeNull();
    expect(obs?.passed).toBeNull();
    expect(result.verdict.verdict).not.toBe("SUPPORTED");
  });
});

describe("regenerated reports preserve all arms and trials", () => {
  it("ablation + sanity arms survive a bundle round-trip", async () => {
    const result = await runExperiment({
      name: "arms",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      baseline: { inline: "echo" },
      ablations: [{ name: "lower", subject: { inline: "lower" } }],
      sanity_baseline: true,
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-regen-"));
    try {
      const spec = {
        name: "arms", dataset: {}, subject: { inline: "upper" },
        baseline: { inline: "echo" },
        ablations: [{ name: "lower", subject: { inline: "lower" } }],
        sanity_baseline: true, evaluator: { type: "exact" },
      } as Parameters<typeof writeEvidenceBundle>[1];
      writeEvidenceBundle(dir, spec, result, buildManifest(spec, result));
      const html = renderHtmlFromBundle(dir);
      expect(html).toContain("treatment");
      expect(html).toContain("baseline");
      expect(html).toContain("lower");
      expect(html).toContain("sanity");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads all rows past 500 without silent truncation", async () => {
    const result = await runExperiment({
      name: "many",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-many-"));
    try {
      const spec = {
        name: "many", dataset: {}, subject: { inline: "upper" }, evaluator: { type: "exact" },
      } as Parameters<typeof writeEvidenceBundle>[1];
      writeEvidenceBundle(dir, spec, result, buildManifest(spec, result));
      // Pad treatment results to 600 rows.
      const p = join(dir, "treatment", "results.jsonl");
      const first = readFileSync(p, "utf8").split("\n").filter(Boolean)[0] as string;
      for (let i = 0; i < 599; i++) appendFileSync(p, `${first}\n`);
      const html = renderHtmlFromBundle(dir);
      expect(html).toContain("Trials (600)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fleiss kappa rejects malformed tables", () => {
  it("ragged rows return null", () => {
    expect(fleissKappa([[1, 1], [1, 0, 1]]).kappa).toBeNull();
  });
  it("fractional counts return null", () => {
    expect(fleissKappa([[1.5, 0.5], [1, 1]]).kappa).toBeNull();
  });
  it("negative counts return null", () => {
    expect(fleissKappa([[2, -1], [1, 2]]).kappa).toBeNull();
  });
  it("well-formed tables still compute", () => {
    const r = fleissKappa([[3, 0], [0, 3], [2, 1]]);
    expect(r.kappa).not.toBeNull();
    expect(r.n).toBe(3);
  });
});

describe("report.html redaction + filter", () => {
  it("nested secrets never reach report.html", async () => {
    const result = await runExperiment({
      name: "html-secret",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
    const poisoned = {
      ...result,
      arms: result.arms.map((a) => ({
        ...a,
        trials: a.trials.map((t) => ({ ...t, output: { nested: { key: secret } } })),
      })),
    };
    const dir = mkdtempSync(join(tmpdir(), "genesis-htmlsec-"));
    try {
      const spec = {
        name: "html-secret", dataset: {}, subject: { inline: "upper" }, evaluator: { type: "exact" },
      } as Parameters<typeof writeEvidenceBundle>[1];
      writeEvidenceBundle(dir, spec, poisoned, buildManifest(spec, poisoned));
      const html = readFileSync(join(dir, "report.html"), "utf8");
      expect(html).not.toContain(secret);
      const treatment = readFileSync(join(dir, "treatment", "results.jsonl"), "utf8");
      expect(treatment).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trial filter handler is syntactically valid", async () => {
    const result = await runExperiment({
      name: "filter",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-filter-"));
    try {
      const spec = {
        name: "filter", dataset: {}, subject: { inline: "upper" }, evaluator: { type: "exact" },
      } as Parameters<typeof writeEvidenceBundle>[1];
      writeEvidenceBundle(dir, spec, result, buildManifest(spec, result));
      const html = readFileSync(join(dir, "report.html"), "utf8");
      expect(html).toContain("filterTrials(this.value)");
      expect(html).not.toContain("filter Trials(this.value)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
