/**
 * The evidence envelope.
 *
 * One shape for every collector, mechanical or judgmental, so the Adjudicator
 * does not know or care where a fact came from.
 *
 * Note what a collector does *not* report: pass or fail. It reports whether
 * collection succeeded (`status`) and what it saw (`observation`). The
 * Adjudicator applies the frozen contract's expectations to that observation.
 * A collector that decided its own pass/fail would be a second place where
 * acceptance policy lives, and the whole design depends on there being exactly
 * one.
 */

export type EvidenceKind = "mechanical" | "behavioral" | "judgmental";

/** Did collection happen, and did it produce a usable observation? */
export type CollectionStatus =
  /** The collector ran and observed something. */
  | "collected"
  /** The collector ran twice with different results — treated as unproven. */
  | "flaky"
  /** The collector failed to run or crashed. Never satisfies a requirement. */
  | "error"
  /** No collector was configured or it was skipped. Never satisfies a requirement. */
  | "not_run";

/** Scalar values an expectation can be evaluated against. */
export type ObservedValue = string | number | boolean | null;

export interface Provenance {
  readonly command: readonly string[];
  readonly exit_code: number | null;
  readonly head_commit: string;
  readonly base_commit: string;
  readonly started_at: string;
  readonly ended_at: string;
  /** Digest over runtime version, lockfile, platform — what "same inputs" means. */
  readonly env_digest: string;
  /** Required for stochastic collectors. `null` for deterministic ones. */
  readonly seed: number | null;
  /**
   * Who produced this evidence. Only `genesis` and `attested_ci` are
   * admissible; see `admissibility.ts`.
   */
  readonly produced_by: "genesis" | "attested_ci" | "executor";
}

export interface Evidence {
  readonly evidence_id: string;
  readonly contract_hash: string;
  readonly criterion_id: string;
  readonly requirement_id: string;
  readonly kind: EvidenceKind;
  readonly collector: {
    readonly name: string;
    readonly version: string;
    readonly adapter_version: string;
  };
  readonly status: CollectionStatus;
  /** What the collector saw. Expectations are evaluated against these keys. */
  readonly observation: Readonly<Record<string, ObservedValue>>;
  /** Human-readable lines the report can cite. Redacted before storage. */
  readonly detail: readonly string[];
  readonly provenance: Provenance;
  /** SHA-256 of the redacted raw artifact, if one was captured. */
  readonly artifact_digest: string | null;
}

/**
 * Deterministic ordering, so adjudication does not depend on the order
 * collectors happened to finish in.
 */
export function sortEvidence(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence].sort((a, b) => {
    if (a.criterion_id !== b.criterion_id) return a.criterion_id < b.criterion_id ? -1 : 1;
    if (a.requirement_id !== b.requirement_id) return a.requirement_id < b.requirement_id ? -1 : 1;
    if (a.evidence_id !== b.evidence_id) return a.evidence_id < b.evidence_id ? -1 : 1;
    return 0;
  });
}
