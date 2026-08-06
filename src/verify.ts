/**
 * The verify pipeline: contract → evidence → verdict → ledger.
 *
 * Everything impure lives here. The Adjudicator it calls is pure, and every
 * fact that pure function needs — including whether the contract genuinely came
 * first — is gathered here and passed in as data.
 */

import { adjudicate, type Adjudication, type PreRegistrationFacts } from "./adjudicator/index.js";
import type { FrozenContract } from "./contract/schema.js";
import { verifyContractHash } from "./contract/freeze.js";
import { filterAdmissible } from "./evidence/admissibility.js";
import { collectEvidence, makeContext, type CollectionEvents } from "./evidence/collect.js";
import type { Evidence } from "./evidence/envelope.js";
import { resolveRef } from "./evidence/git.js";
import { checkPreRegistration } from "./evidence/preregistration.js";
import type { CollectorRegistry } from "./evidence/registry.js";
import { computeEnvDigest, SubprocessRunner, type Runner } from "./evidence/runner.js";
import { Ledger } from "./ledger/ledger.js";

export class VerifyError extends Error {
  override readonly name = "VerifyError";
}

export interface VerifyOptions {
  readonly repoPath: string;
  readonly contract: FrozenContract;
  readonly ledger: Ledger;
  readonly registry: CollectorRegistry;
  readonly head?: string;
  readonly runner?: Runner;
  readonly events?: CollectionEvents;
  /** Deterministic evidence ids, for tests and reproducible fixtures. */
  readonly idSeed?: string;
}

export interface VerifyResult {
  readonly adjudication: Adjudication;
  readonly evidence: readonly Evidence[];
  readonly rejected: ReadonlyArray<{ evidence: Evidence; reason: string }>;
  readonly preRegistration: PreRegistrationFacts;
  readonly headCommit: string;
  readonly verdictEntryHash: string;
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const { contract, ledger, registry, repoPath } = options;

  if (!verifyContractHash(contract)) {
    throw new VerifyError(
      "the contract's stored hash does not match its contents — it was modified after freezing",
    );
  }

  // Pre-registration is not a preference. A contract that was never frozen into
  // the ledger has no timestamped, tamper-evident existence prior to the work,
  // so there is nothing to grade against.
  const registered = ledger.getContract(contract.contract_hash);
  if (!registered) {
    throw new VerifyError(
      `contract ${contract.contract_hash.slice(0, 12)} is not in the ledger. ` +
        "Run `genesis contract freeze` before implementation begins — Genesis does not " +
        "grade against contracts it cannot prove came first.",
    );
  }

  const headCommit =
    resolveRef(repoPath, options.head ?? "HEAD") ?? options.head ?? "unknown";
  const baseCommit = resolveRef(repoPath, contract.repo.base_commit) ?? contract.repo.base_commit;

  const ctx = makeContext({
    repoPath,
    contractHash: contract.contract_hash,
    headCommit,
    baseCommit,
    envDigest: computeEnvDigest(repoPath),
    runner: options.runner ?? new SubprocessRunner(),
    putArtifact: (content) => ledger.putArtifact(content),
    idSeed: options.idSeed,
  });

  const collected = await collectEvidence(contract, registry, ctx, options.events);

  // Everything is recorded, including what will be ruled inadmissible. The
  // attempt is data: a repository that keeps submitting executor-produced
  // evidence is telling us something worth having in the calibration set.
  for (const record of collected) ledger.recordEvidence(record);

  const { admissible, rejected } = filterAdmissible(collected);
  const preRegistration = checkPreRegistration(repoPath, contract, headCommit);

  const adjudication = adjudicate({ contract, evidence: admissible, preRegistration });

  const entry = ledger.recordVerdict(adjudication, {
    head_commit: headCommit,
    base_commit: baseCommit,
    pre_registration: preRegistration,
    evidence_ids: admissible.map((e) => e.evidence_id),
    inadmissible: rejected.map((r) => ({ evidence_id: r.evidence.evidence_id, reason: r.reason })),
    contract_provenance: contract.provenance,
  });

  return {
    adjudication,
    evidence: collected,
    rejected,
    preRegistration,
    headCommit,
    verdictEntryHash: entry.entry_hash,
  };
}

/** Process exit codes. Distinct so CI can block on one and route the other. */
export const EXIT_CODES = {
  SHIP: 0,
  NOT_READY: 1,
  HUMAN_REVIEW: 2,
  /** Genesis itself failed. Must never be confusable with a repository failing. */
  INTERNAL_ERROR: 3,
} as const;

export function exitCodeFor(verdict: Adjudication["verdict"]): number {
  return EXIT_CODES[verdict];
}
