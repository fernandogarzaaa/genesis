/**
 * Inter-rater agreement (κ) + interactive multi-turn execution.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cohenKappa, fleissKappa, interpretKappa } from "../src/eval/agreement.js";
import { computeMetric } from "../src/eval/metrics.js";
import { renderReport } from "../src/eval/report.js";
import { runExperiment } from "../src/eval/runner.js";
import { loadSpecFile } from "../src/eval/spec.js";

describe("cohen kappa", () => {
  it("is 1 for perfect agreement", () => {
    const r = cohenKappa([true, true, false], [true, true, false]);
    expect(r.kappa).toBe(1);
    expect(r.n).toBe(3);
    expect(r.interpretation).toBe("near-perfect agreement");
  });

  it("discounts chance agreement (hand-computed 1/3)", () => {
    const r = cohenKappa(
      [true, true, false, false, true, false],
      [true, false, false, false, true, true],
    );
    expect(r.n).toBe(6);
    expect(r.kappa).toBeCloseTo(1 / 3, 4);
    expect(r.interpretation).toBe("fair agreement");
  });

  it("works on string labels and skips nulls", () => {
    const r = cohenKappa(["cat", "dog", null], ["cat", "cat", "dog"]);
    expect(r.n).toBe(2);
    expect(r.kappa).toBe(0);
  });

  it("is null when empty or chance agreement is 1", () => {
    expect(cohenKappa([], []).kappa).toBeNull();
    expect(cohenKappa([true, true], [true, true]).kappa).toBeNull();
  });

  it("labels bands", () => {
    expect(interpretKappa(-0.1)).toBe("systematic disagreement");
    expect(interpretKappa(0.1)).toBe("slight agreement");
    expect(interpretKappa(0.5)).toBe("moderate agreement");
    expect(interpretKappa(0.9)).toBe("near-perfect agreement");
    expect(interpretKappa(null)).toBeNull();
  });
});

describe("fleiss kappa", () => {
  it("matches the hand-computed 0.55 case", () => {
    const r = fleissKappa([[3, 0], [0, 3], [2, 1]]);
    expect(r.n).toBe(3);
    expect(r.kappa).toBeCloseTo(0.55, 2);
  });

  it("rejects ragged coverage and degenerate inputs", () => {
    expect(fleissKappa([[2, 0], [1, 0]]).kappa).toBeNull(); // rows sum 2 vs 1
    expect(fleissKappa([[1, 0]]).kappa).toBeNull(); // single rater
    expect(fleissKappa([]).kappa).toBeNull();
  });
});

describe("human agreement wiring", () => {
  function judgments(dir: string): { primary: string; secondary: string } {
    const primary = join(dir, "r1.jsonl");
    const secondary = join(dir, "r2.jsonl");
    writeFileSync(primary, '{"task_id":"task-0001","passed":true}\n{"task_id":"task-0002","passed":false}\n{"task_id":"task-0003","passed":true}\n', "utf8");
    writeFileSync(secondary, '{"task_id":"task-0001","passed":true}\n{"task_id":"task-0002","passed":true}\n{"task_id":"task-0003","passed":true}\n', "utf8");
    return { primary, secondary };
  }

  it("surfaces κ in describe, arms, bundles, and reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-agree-"));
    try {
      const { primary, secondary } = judgments(dir);
      const result = await runExperiment({
        name: "agree",
        dataset: { inline: [{ input: "a" }, { input: "b" }, { input: "c" }] },
        subject: { inline: "echo" },
        evaluator: { type: "human", judgments: primary, judgments_secondary: secondary },
        metrics: ["task_success"],
      });
      // 2/3 agree; marginals r1 {T,T,F}, r2 {T,T,T}: Po=2/3, Pe=(2/3)(1)+(1/3)(0)=2/3 → κ=0.
      const agreement = result.arms[0]?.evaluator_agreement;
      expect(agreement?.n).toBe(3);
      expect(agreement?.cohen_kappa).toBe(0);
      expect(renderReport(result)).toContain("inter-rater κ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is absent without a second rater", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-agree-"));
    try {
      const { primary } = judgments(dir);
      const result = await runExperiment({
        name: "agree",
        dataset: { inline: [{ input: "a" }] },
        subject: { inline: "echo" },
        evaluator: { type: "human", judgments: primary },
        metrics: ["task_success"],
      });
      expect(result.arms[0]?.evaluator_agreement).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("multi-turn execution", () => {
  it("loops over turns, keeps transcripts, judges the final message", async () => {
    const result = await runExperiment({
      name: "mt",
      dataset: {
        inline: [{
          id: "t1", input: "start", reference: "c",
          turns: ["first", "second", "c"],
        }],
      },
      subject: { inline: "echo" },
      evaluator: { type: "exact" },
      metrics: ["task_success", "mean_turns"],
      thresholds: { task_success: ">=1.0" },
    });
    const trial = result.arms[0]?.trials[0];
    expect(trial?.output).toBe("c");
    expect(trial?.transcript?.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(trial?.transcript?.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["first", "second", "c"]);
    expect(result.verdict.verdict).toBe("SUPPORTED");
    expect(computeMetric("mean_turns", { trials: result.arms[0]?.trials ?? [], observations: result.arms[0]?.observations ?? [] }).value).toBe(3);
  });

  it("stops early on done and honors max_turns", async () => {
    const five = {
      id: "t1", input: "start", reference: "final",
      turns: ["one", "two", "three", "four", "five"],
    };
    const done = await runExperiment({
      name: "mt-done",
      dataset: { inline: [five] },
      subject: { command: "node tests/fixtures/multiturn.mjs {task_file}" },
      evaluator: { type: "exact" },
      metrics: ["task_success", "mean_turns"],
    });
    // Fixture answers "final" + done on its second turn.
    expect(done.arms[0]?.trials[0]?.output).toBe("final");
    expect(done.arms[0]?.trials[0]?.transcript?.length).toBe(4);
    const capped = await runExperiment({
      name: "mt-cap",
      dataset: { inline: [five] },
      subject: { inline: "echo" },
      evaluator: { type: "pass_through" },
      metrics: ["mean_turns"],
      max_turns: 2,
    });
    expect(capped.arms[0]?.trials[0]?.transcript?.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("single-shot trials carry no transcript", async () => {
    const result = await runExperiment({
      name: "mt-single",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success", "mean_turns"],
    });
    expect(result.arms[0]?.trials[0]?.transcript).toBeUndefined();
    expect(result.arms[0]?.metrics.find((m) => m.metric === "mean_turns")).toBeUndefined();
  });

  it("multiturn example runs end to end with transcripts in the bundle", async () => {
    const result = await runExperiment(loadSpecFile("examples/multiturn/evaluation.yaml"));
    expect(result.verdict.verdict).toBe("SUPPORTED");
    expect(result.arms[0]?.trials.every((t) => (t.transcript?.length ?? 0) === 6)).toBe(true);
  }, 120_000);
});
