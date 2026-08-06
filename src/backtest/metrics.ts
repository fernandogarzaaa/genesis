/**
 * Calibration metrics.
 *
 * The long-term success metric for Genesis is not feature count — it is how
 * often its verdicts matched reality. These are the numbers that answer that,
 * and their design carries three deliberate refusals:
 *
 *  1. **No "accuracy."** The costs are wildly asymmetric. A false SHIP on a
 *     change that later broke production destroys trust permanently; a false
 *     NOT READY costs someone twenty minutes. One number that averages them is
 *     worse than no number.
 *
 *  2. **No pooling of reconstructed and pre-registered contracts.** A contract
 *     reconstructed from a merged diff has seen the answer, so its criteria are
 *     optimistically shaped no matter how carefully it was written.
 *     Reconstructed contracts measure whether the evidence pipeline
 *     discriminates. Only pre-registered contracts measure whether Genesis
 *     works. `summarize` throws rather than mix them.
 *
 *  3. **No bare point estimates.** Every rate carries a Wilson interval,
 *     because at n=60 the intervals are wide and saying so is part of the
 *     deliverable.
 */

import type { Verdict } from "../adjudicator/index.js";
import type { OutcomeLabel } from "../ledger/ledger.js";
import type { ContractProvenance } from "../contract/schema.js";

export interface BacktestCase {
  readonly id: string;
  readonly contract_hash: string;
  readonly provenance: ContractProvenance;
  readonly verdict: Verdict;
  readonly outcome: OutcomeLabel;
}

export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

export interface BacktestSummary {
  readonly provenance: ContractProvenance;
  readonly cases: number;
  readonly problematic: number;
  readonly clean: number;
  /** P(SHIP | reverted ∨ hotfixed). The number that matters. Target ~0. */
  readonly false_ship_rate: Interval;
  /** P(NOT_READY | merged_clean). The adoption cost. */
  readonly block_rate_on_clean: Interval;
  /** P(verdict ≠ HUMAN_REVIEW). A gate that always escalates has no value. */
  readonly coverage: Interval;
  /** P(problematic | HUMAN_REVIEW) — is the hand-raise informative? */
  readonly escalation_precision: Interval;
  /** Base rate of problematic outcomes in this sample. */
  readonly sample_problematic_rate: Interval;
  readonly confusion: ReadonlyArray<{ verdict: Verdict; outcome: OutcomeLabel; count: number }>;
  readonly caveats: readonly string[];
}

/** Outcomes that mean the change should not have shipped as it was. */
const PROBLEMATIC: ReadonlySet<OutcomeLabel> = new Set(["reverted", "hotfixed"]);

export function isProblematic(outcome: OutcomeLabel): boolean {
  return PROBLEMATIC.has(outcome);
}

export class MixedProvenanceError extends Error {
  override readonly name = "MixedProvenanceError";
}

export function summarize(cases: readonly BacktestCase[]): BacktestSummary {
  const provenances = new Set(cases.map((c) => c.provenance));
  if (provenances.size > 1) {
    throw new MixedProvenanceError(
      "refusing to summarize pre-registered and reconstructed contracts together. " +
        "A reconstructed contract has seen the answer; pooling them produces a headline " +
        "number that is both excellent and meaningless. Summarize each set separately.",
    );
  }

  const provenance = [...provenances][0] ?? "pre_registered";
  const problematic = cases.filter((c) => isProblematic(c.outcome));
  const clean = cases.filter((c) => c.outcome === "merged_clean");
  const escalated = cases.filter((c) => c.verdict === "HUMAN_REVIEW");

  const summary: BacktestSummary = {
    provenance,
    cases: cases.length,
    problematic: problematic.length,
    clean: clean.length,

    false_ship_rate: wilson(problematic.filter((c) => c.verdict === "SHIP").length, problematic.length),
    block_rate_on_clean: wilson(clean.filter((c) => c.verdict === "NOT_READY").length, clean.length),
    coverage: wilson(cases.filter((c) => c.verdict !== "HUMAN_REVIEW").length, cases.length),
    escalation_precision: wilson(escalated.filter((c) => isProblematic(c.outcome)).length, escalated.length),
    sample_problematic_rate: wilson(problematic.length, cases.length),

    confusion: confusionMatrix(cases),
    caveats: caveatsFor(provenance, cases),
  };

  return summary;
}

function caveatsFor(provenance: ContractProvenance, cases: readonly BacktestCase[]): string[] {
  const caveats: string[] = [];

  if (provenance === "reconstructed") {
    caveats.push(
      "These contracts were reconstructed after the fact and had sight of the merged diff. " +
        "They measure whether the evidence pipeline discriminates, not whether Genesis works " +
        "in deployment. Only pre-registered contracts measure the latter.",
    );
  }

  const rate = cases.length > 0 ? cases.filter((c) => isProblematic(c.outcome)).length / cases.length : 0;
  if (rate > 0.2) {
    caveats.push(
      `This sample is ${(rate * 100).toFixed(0)}% problematic. Real repositories revert 2-5% of ` +
        "pull requests, so a balanced sample measures discrimination, not deployed precision. " +
        "Do not quote these rates as production numbers.",
    );
  }

  if (cases.length < 100) {
    caveats.push(
      `n=${cases.length}. The intervals below are wide; treat point estimates as indicative only.`,
    );
  }

  const coverage = cases.length > 0
    ? cases.filter((c) => c.verdict !== "HUMAN_REVIEW").length / cases.length
    : 0;
  if (coverage < 0.3) {
    caveats.push(
      `Coverage is ${(coverage * 100).toFixed(0)}%: Genesis escalated most cases to a human. ` +
        "A low false-ship rate achieved this way is not evidence the system works — a verifier " +
        "that always says HUMAN REVIEW scores perfectly on safety and is worthless.",
    );
  }

  return caveats;
}

function confusionMatrix(
  cases: readonly BacktestCase[],
): Array<{ verdict: Verdict; outcome: OutcomeLabel; count: number }> {
  const counts = new Map<string, number>();
  for (const c of cases) {
    const key = `${c.verdict}|${c.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [verdict, outcome] = key.split("|") as [Verdict, OutcomeLabel];
      return { verdict, outcome, count };
    })
    .sort((a, b) => (a.verdict === b.verdict ? a.outcome.localeCompare(b.outcome) : a.verdict.localeCompare(b.verdict)));
}

/**
 * Wilson score interval at 95%.
 *
 * Chosen over the normal approximation because these proportions cluster near
 * 0 and 1 — exactly where the normal approximation produces intervals that
 * extend below zero and quietly mislead.
 */
export function wilson(successes: number, total: number, z = 1.959963984540054): Interval {
  if (total === 0) return { point: 0, low: 0, high: 0, n: 0 };

  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));

  return {
    point: round(p),
    low: round(Math.max(0, center - spread)),
    high: round(Math.min(1, center + spread)),
    n: total,
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function formatInterval(interval: Interval): string {
  if (interval.n === 0) return "n/a (no cases)";
  return (
    `${(interval.point * 100).toFixed(1)}% ` +
    `[${(interval.low * 100).toFixed(1)}–${(interval.high * 100).toFixed(1)}%, n=${interval.n}]`
  );
}
