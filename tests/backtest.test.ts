import { describe, expect, it } from "vitest";
import { backtestDataset, backtestLedger, type DatasetCase } from "../src/backtest/index.js";
import {
  MixedProvenanceError,
  summarize,
  wilson,
  type BacktestCase,
} from "../src/backtest/metrics.js";
import { adjudicate } from "../src/adjudicator/index.js";
import { Ledger } from "../src/ledger/ledger.js";
import { CLEAN_PRE_REGISTRATION, evidence, frozen } from "./helpers.js";

function bcase(overrides: Partial<BacktestCase> = {}): BacktestCase {
  return {
    id: "case",
    contract_hash: "abc",
    provenance: "pre_registered",
    verdict: "SHIP",
    outcome: "merged_clean",
    ...overrides,
  };
}

describe("wilson interval", () => {
  it("returns a zero interval for an empty sample", () => {
    expect(wilson(0, 0)).toEqual({ point: 0, low: 0, high: 0, n: 0 });
  });

  it("never produces bounds outside [0,1] at the extremes", () => {
    const none = wilson(0, 10);
    expect(none.low).toBeGreaterThanOrEqual(0);
    expect(none.point).toBe(0);

    const all = wilson(10, 10);
    expect(all.high).toBeLessThanOrEqual(1);
    expect(all.point).toBe(1);
  });

  it("produces a wide interval at small n and a narrow one at large n", () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it("matches the known interval for 5/10", () => {
    const interval = wilson(5, 10);
    expect(interval.low).toBeCloseTo(0.2366, 3);
    expect(interval.high).toBeCloseTo(0.7634, 3);
  });
});

describe("summarize — the refusal to pool provenances", () => {
  it("throws rather than mix reconstructed and pre-registered contracts", () => {
    expect(() =>
      summarize([bcase({ provenance: "pre_registered" }), bcase({ provenance: "reconstructed" })]),
    ).toThrow(MixedProvenanceError);
  });

  it("explains why in the error", () => {
    try {
      summarize([bcase({ provenance: "pre_registered" }), bcase({ provenance: "reconstructed" })]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("has seen the answer");
    }
  });
});

describe("summarize — metrics", () => {
  const cases: BacktestCase[] = [
    // Genesis said SHIP and the change was fine.
    ...Array.from({ length: 8 }, (_, i) => bcase({ id: `ok-${i}`, verdict: "SHIP", outcome: "merged_clean" })),
    // Genesis said SHIP and the change was reverted. The failure that matters.
    bcase({ id: "false-ship", verdict: "SHIP", outcome: "reverted" }),
    // Genesis blocked a change that did get reverted.
    ...Array.from({ length: 3 }, (_, i) => bcase({ id: `caught-${i}`, verdict: "NOT_READY", outcome: "reverted" })),
    // Genesis blocked a change that was actually fine.
    bcase({ id: "false-block", verdict: "NOT_READY", outcome: "merged_clean" }),
    // Escalations.
    bcase({ id: "esc-1", verdict: "HUMAN_REVIEW", outcome: "hotfixed" }),
    bcase({ id: "esc-2", verdict: "HUMAN_REVIEW", outcome: "merged_clean" }),
  ];

  const summary = summarize(cases);

  it("computes the false-ship rate over problematic outcomes only", () => {
    // 5 problematic (1 reverted + 3 reverted + 1 hotfixed), 1 of which shipped.
    expect(summary.problematic).toBe(5);
    expect(summary.false_ship_rate.point).toBeCloseTo(1 / 5, 4);
  });

  it("computes the block rate over clean merges only", () => {
    // 10 clean, 1 of which was blocked.
    expect(summary.clean).toBe(10);
    expect(summary.block_rate_on_clean.point).toBeCloseTo(1 / 10, 4);
  });

  it("computes coverage as the share of non-escalated verdicts", () => {
    expect(summary.coverage.point).toBeCloseTo(13 / 15, 4);
  });

  it("computes escalation precision against the sample base rate", () => {
    expect(summary.escalation_precision.point).toBeCloseTo(1 / 2, 4);
    expect(summary.sample_problematic_rate.point).toBeCloseTo(5 / 15, 4);
  });

  it("builds a confusion matrix", () => {
    const cell = summary.confusion.find((c) => c.verdict === "SHIP" && c.outcome === "reverted");
    expect(cell?.count).toBe(1);
  });
});

describe("summarize — caveats", () => {
  it("warns that a balanced sample does not measure deployed precision", () => {
    const balanced = [
      ...Array.from({ length: 5 }, (_, i) => bcase({ id: `a${i}`, outcome: "merged_clean" })),
      ...Array.from({ length: 5 }, (_, i) => bcase({ id: `b${i}`, outcome: "reverted", verdict: "NOT_READY" })),
    ];
    expect(summarize(balanced).caveats.join(" ")).toContain("2-5%");
  });

  it("flags reconstructed contracts as not measuring whether Genesis works", () => {
    const reconstructed = [bcase({ provenance: "reconstructed" })];
    expect(summarize(reconstructed).caveats.join(" ")).toContain("reconstructed after the fact");
  });

  // The failure mode a single accuracy number would hide.
  it("flags a verifier that achieves safety by escalating everything", () => {
    const alwaysEscalate = Array.from({ length: 20 }, (_, i) =>
      bcase({ id: `e${i}`, verdict: "HUMAN_REVIEW", outcome: i % 2 === 0 ? "merged_clean" : "reverted" }),
    );
    const summary = summarize(alwaysEscalate);
    expect(summary.false_ship_rate.point).toBe(0);
    expect(summary.caveats.join(" ")).toContain("worthless");
  });

  it("notes small sample size", () => {
    expect(summarize([bcase()]).caveats.join(" ")).toContain("n=1");
  });
});

describe("backtestDataset", () => {
  it("replays contracts and evidence through the current adjudicator", () => {
    const passing = frozen();
    const failing = frozen({ objective: "a different objective" });

    const cases: DatasetCase[] = [
      {
        id: "pr-1",
        contract: passing,
        evidence: [evidence({ contract_hash: passing.contract_hash, observation: { failed: 0 } })],
        outcome: "merged_clean",
      },
      {
        id: "pr-2",
        contract: failing,
        evidence: [evidence({ contract_hash: failing.contract_hash, observation: { failed: 2 } })],
        outcome: "reverted",
      },
    ];

    const report = backtestDataset(cases);
    expect(report.cases.map((c) => c.verdict)).toEqual(["SHIP", "NOT_READY"]);
    expect(report.summaries).toHaveLength(1);
    expect(report.summaries[0]?.false_ship_rate.point).toBe(0);
  });

  it("separates provenances into separate summaries", () => {
    const a = frozen({ provenance: "pre_registered" });
    const b = frozen({ provenance: "reconstructed", objective: "other" });

    const report = backtestDataset([
      { id: "1", contract: a, evidence: [evidence({ contract_hash: a.contract_hash })], outcome: "merged_clean" },
      { id: "2", contract: b, evidence: [evidence({ contract_hash: b.contract_hash })], outcome: "reverted" },
    ]);

    expect(report.summaries).toHaveLength(2);
    expect(report.summaries.map((s) => s.provenance).sort()).toEqual(["pre_registered", "reconstructed"]);
  });

  it("excludes inadmissible evidence, which drives the verdict to HUMAN_REVIEW", () => {
    const contract = frozen();
    const report = backtestDataset([
      {
        id: "1",
        contract,
        evidence: [
          evidence({
            contract_hash: contract.contract_hash,
            provenance: { ...evidence().provenance, produced_by: "executor" },
          }),
        ],
        outcome: "merged_clean",
      },
    ]);

    expect(report.cases[0]?.verdict).toBe("HUMAN_REVIEW");
  });
});

describe("backtestLedger", () => {
  it("skips contracts with no outcome label", () => {
    const ledger = new Ledger(":memory:");
    const contract = frozen();
    ledger.registerContract(contract);
    ledger.recordEvidence(evidence({ contract_hash: contract.contract_hash }));

    const report = backtestLedger(ledger);
    expect(report.cases).toHaveLength(0);
    expect(report.skipped[0]?.reason).toContain("no outcome label");
    ledger.close();
  });

  it("replays a labeled contract end to end", () => {
    const ledger = new Ledger(":memory:");
    const contract = frozen();
    ledger.registerContract(contract);

    const record = evidence({ contract_hash: contract.contract_hash, observation: { failed: 0 } });
    ledger.recordEvidence(record);
    ledger.recordVerdict(
      adjudicate({ contract, evidence: [record], preRegistration: CLEAN_PRE_REGISTRATION }),
      { pre_registration: CLEAN_PRE_REGISTRATION },
    );
    ledger.labelOutcome(contract.contract_hash, {
      label: "reverted",
      label_source: "manual",
      verdict_entry_hash: null,
      detail: {},
      supersedes: null,
    });

    const report = backtestLedger(ledger);
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]?.verdict).toBe("SHIP");
    expect(report.cases[0]?.outcome).toBe("reverted");
    // One false ship out of one problematic case.
    expect(report.summaries[0]?.false_ship_rate.point).toBe(1);
    ledger.close();
  });

  it("uses the most recent outcome label when one supersedes another", () => {
    const ledger = new Ledger(":memory:");
    const contract = frozen();
    ledger.registerContract(contract);
    const record = evidence({ contract_hash: contract.contract_hash });
    ledger.recordEvidence(record);

    const first = ledger.labelOutcome(contract.contract_hash, {
      label: "merged_clean", label_source: "manual", verdict_entry_hash: null, detail: {}, supersedes: null,
    });
    ledger.labelOutcome(contract.contract_hash, {
      label: "reverted", label_source: "manual", verdict_entry_hash: null, detail: {}, supersedes: first.entry_hash,
    });

    expect(backtestLedger(ledger).cases[0]?.outcome).toBe("reverted");
    ledger.close();
  });
});
