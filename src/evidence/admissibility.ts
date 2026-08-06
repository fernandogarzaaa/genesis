/**
 * Admissibility — the neutrality principle, mechanized.
 *
 *   "The executor cannot grade itself."
 *
 * That principle is decorative unless it is enforced at the data layer. Genesis
 * therefore admits evidence from exactly two sources:
 *
 *   1. `genesis`      — Genesis ran the command itself and holds the artifact.
 *   2. `attested_ci`  — fetched from a CI provider's API over an authenticated
 *                       channel, where the provider vouches for the result.
 *
 * Everything else is inadmissible. A `test-results.json` committed into the
 * diff is not evidence. A summary the agent writes in the PR body is not
 * evidence. Inadmissible records are still recorded in the ledger — the
 * attempt is data — but they are excluded from adjudication.
 *
 * This rule is small and easy to skip. It is also the difference between an
 * independent acceptance layer and an elaborate way of asking the agent whether
 * it is finished.
 */

import type { Evidence } from "./envelope.js";

export interface AdmissibilityRuling {
  readonly admissible: readonly Evidence[];
  readonly rejected: ReadonlyArray<{ readonly evidence: Evidence; readonly reason: string }>;
}

export function filterAdmissible(evidence: readonly Evidence[]): AdmissibilityRuling {
  const admissible: Evidence[] = [];
  const rejected: Array<{ evidence: Evidence; reason: string }> = [];

  for (const record of evidence) {
    const reason = inadmissibleReason(record);
    if (reason === null) admissible.push(record);
    else rejected.push({ evidence: record, reason });
  }

  return { admissible, rejected };
}

/** Returns `null` when the record is admissible, otherwise why it is not. */
export function inadmissibleReason(record: Evidence): string | null {
  if (record.provenance.produced_by === "executor") {
    return "produced by the executor being graded; the executor cannot grade itself";
  }

  if (
    record.provenance.produced_by !== "genesis" &&
    record.provenance.produced_by !== "attested_ci"
  ) {
    return `unknown provenance "${String(record.provenance.produced_by)}"`;
  }

  // A stochastic collector that did not record its seed cannot be reproduced,
  // and evidence that cannot be reproduced cannot be re-adjudicated later —
  // which is the whole point of keeping the ledger.
  if (record.kind === "behavioral" && record.status === "collected" && record.provenance.seed === null) {
    return "behavioral evidence without a recorded seed is not reproducible";
  }

  return null;
}
