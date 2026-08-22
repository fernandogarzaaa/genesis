/**
 * Backtest harness — the validation artifact.
 *
 * The question is not whether Genesis has features. It is: *how often did
 * Genesis agree with reality?* This replays contracts and evidence through the
 * current Adjudicator and joins the verdicts against what actually happened.
 *
 * Two sources:
 *   - `--from-ledger`: every contract in the ledger that has an outcome label.
 *     This is the real one, and it grows on its own once the CI gate is live.
 *   - `--dataset f.jsonl`: contracts and evidence supplied inline, for
 *     bootstrapping against historical pull requests before the ledger has
 *     accumulated anything.
 *
 * Replaying through the *current* adjudicator is the point. If its logic
 * changes, this re-derives every historical verdict, so a behavior change shows
 * up as a diff in the calibration numbers rather than silently invalidating
 * them. `adjudicator_version` is recorded with every verdict so cross-version
 * comparisons stay possible.
 */

import { adjudicate, type PreRegistrationFacts } from "../adjudicator/index.js";
import type { FrozenContract } from "../contract/schema.js";
import { filterAdmissible } from "../evidence/admissibility.js";
import type { Evidence } from "../evidence/envelope.js";
import type { Ledger, OutcomeLabel, OutcomePayload } from "../ledger/ledger.js";
import {
  summarize,
  type BacktestCase,
  type BacktestSummary,
} from "./metrics.js";

/** One historical case supplied out of band. */
export interface DatasetCase {
  readonly id: string;
  readonly contract: FrozenContract;
  readonly evidence: readonly Evidence[];
  readonly outcome: OutcomeLabel;
  readonly pre_registration?: Partial<PreRegistrationFacts>;
}

export interface BacktestReport {
  /** One summary per contract provenance. Never pooled — see metrics.ts. */
  readonly summaries: readonly BacktestSummary[];
  readonly cases: readonly BacktestCase[];
  readonly skipped: ReadonlyArray<{ id: string; reason: string }>;
  readonly adjudicator_version: string;
}

/**
 * Historical cases were not pre-registered — that is what makes them
 * historical. Assuming otherwise would let every case fail on the
 * pre-registration check and report a meaningless 100% block rate, so the
 * default asserts the facts held and the contract's `provenance` field carries
 * the honesty instead.
 */
const ASSUMED_PRE_REGISTRATION: PreRegistrationFacts = {
  determined: true,
  base_is_ancestor: true,
  frozen_before_first_commit: true,
  amended_after_first_commit: false,
};

export function backtestDataset(cases: readonly DatasetCase[]): BacktestReport {
  const results: BacktestCase[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let version = "";

  for (const item of cases) {
    const { admissible } = filterAdmissible(item.evidence);
    const adjudication = adjudicate({
      contract: item.contract,
      evidence: admissible,
      preRegistration: { ...ASSUMED_PRE_REGISTRATION, ...item.pre_registration },
    });
    version = adjudication.adjudicator_version;

    results.push({
      id: item.id,
      contract_hash: item.contract.contract_hash,
      provenance: item.contract.provenance,
      verdict: adjudication.verdict,
      outcome: item.outcome,
    });
  }

  return {
    summaries: summarizeByProvenance(results),
    cases: results,
    skipped,
    adjudicator_version: version,
  };
}

/** Replay every labeled contract in the ledger. */
export function backtestLedger(ledger: Ledger): BacktestReport {
  const results: BacktestCase[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let version = "";

  for (const contractHash of new Set(ledger.contractHashes())) {
    const short = contractHash.slice(0, 12);

    const contractEntry = ledger.getContract(contractHash);
    if (!contractEntry) {
      skipped.push({ id: short, reason: "no contract entry" });
      continue;
    }

    const outcome = latestOutcome(ledger, contractHash);
    if (!outcome) {
      skipped.push({ id: short, reason: "no outcome label yet — a verdict without an outcome is an opinion" });
      continue;
    }

    const evidence = ledger
      .entries({ type: "EVIDENCE_RECORDED", contract_hash: contractHash })
      .map((entry) => entry.payload as Evidence);

    if (evidence.length === 0) {
      skipped.push({ id: short, reason: "no evidence recorded" });
      continue;
    }

    const { admissible } = filterAdmissible(evidence);
    const adjudication = adjudicate({
      contract: contractEntry.payload,
      evidence: admissible,
      preRegistration: preRegistrationFromLedger(ledger, contractHash),
    });
    version = adjudication.adjudicator_version;

    results.push({
      id: short,
      contract_hash: contractHash,
      provenance: contractEntry.payload.provenance,
      verdict: adjudication.verdict,
      outcome,
    });
  }

  return {
    summaries: summarizeByProvenance(results),
    cases: results,
    skipped,
    adjudicator_version: version,
  };
}

function summarizeByProvenance(cases: readonly BacktestCase[]): BacktestSummary[] {
  const groups = new Map<string, BacktestCase[]>();
  for (const c of cases) {
    const list = groups.get(c.provenance);
    if (list) list.push(c);
    else groups.set(c.provenance, [c]);
  }
  // Sorted so report output is stable between runs.
  return [...groups.keys()].sort().map((key) => summarize(groups.get(key) ?? []));
}

/** The most recent label wins; superseded labels stay in the chain. */
function latestOutcome(ledger: Ledger, contractHash: string): OutcomeLabel | null {
  const entries = ledger.entries({ type: "OUTCOME_LABELED", contract_hash: contractHash });
  const last = entries.at(-1);
  return last ? (last.payload as OutcomePayload).label : null;
}

/** Recover the pre-registration facts recorded alongside the original verdict. */
function preRegistrationFromLedger(ledger: Ledger, contractHash: string): PreRegistrationFacts {
  const verdicts = ledger.entries({ type: "VERDICT_RENDERED", contract_hash: contractHash });
  const last = verdicts.at(-1);
  const context = last?.payload as { context?: { pre_registration?: PreRegistrationFacts } } | undefined;
  return context?.context?.pre_registration ?? ASSUMED_PRE_REGISTRATION;
}
