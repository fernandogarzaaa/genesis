/**
 * Acceptance contract schema.
 *
 * A contract states what would *prove* an objective was met, in terms a machine
 * can check, and it is frozen before implementation begins. Its two
 * non-negotiable properties:
 *
 *  1. Every criterion is falsifiable — see `validate.ts`, which rejects
 *     contracts that are not. "Users can login securely" is not a criterion.
 *  2. Expectations live in the contract, not in the collector. A collector
 *     reports what it observed; the Adjudicator compares that observation to
 *     the frozen expectation. This keeps the pass/fail decision on the
 *     authoritative side of the boundary, and it is what makes replay
 *     meaningful — the same evidence re-adjudicated against an amended
 *     threshold yields a different verdict, which is exactly what calibration
 *     needs to measure.
 */

import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0";

// ── Expectations ────────────────────────────────────────────────────────────

/**
 * A predicate over one named value in a collector's observation.
 *
 * Deliberately small. Every operator is total, deterministic, and decidable
 * without I/O — the Adjudicator has to stay pure, and an expectation language
 * with escape hatches is how that property gets lost.
 */
export const ExpectationSchema = z.object({
  /** Key into the collector's `observation` map. */
  metric: z.string().min(1),
  op: z.enum(["equals", "not_equals", "lt", "lte", "gt", "gte", "one_of"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ]),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

// ── Evidence requirements ───────────────────────────────────────────────────

export const EvidenceKindSchema = z.enum(["mechanical", "behavioral", "judgmental"]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const RequirementSchema = z.object({
  /** Stable within the contract. Assigned by the compiler as `<criterion>#<n>`. */
  id: z.string().min(1),
  kind: EvidenceKindSchema,
  /** Name of a registered collector. Validated against the live registry. */
  collector: z.string().min(1),
  /** Collector-specific input: a test selector, a command, an EVE session spec. */
  config: z.record(z.string(), z.unknown()).default({}),
  /** All expectations must hold for this requirement to be satisfied. */
  expect: z.array(ExpectationSchema).min(1),
});
export type Requirement = z.infer<typeof RequirementSchema>;

// ── Criteria ────────────────────────────────────────────────────────────────

export const CriterionSchema = z.object({
  id: z.string().min(1),
  /** What must be true. One claim, not a paragraph. */
  statement: z.string().min(1),
  /**
   * Binding criteria decide the verdict. Non-binding criteria are collected,
   * recorded, and reported as advisories — they never block, but they are in
   * the ledger, where calibration can discover that one of them predicts
   * reverts better than the binding ones do.
   */
  binding: z.boolean().default(true),
  /** An observable state that would mean this criterion is not met. */
  failure_condition: z.string().min(1),
  evidence_requirements: z.array(RequirementSchema).min(1),
});
export type Criterion = z.infer<typeof CriterionSchema>;

// ── Contract ────────────────────────────────────────────────────────────────

/**
 * Whether the contract was written before the work (`pre_registered`) or
 * reconstructed afterwards from a merged diff (`reconstructed`).
 *
 * A reconstructed contract has seen the answer, so its criteria are
 * optimistically shaped no matter how carefully it was written. The backtest
 * refuses to pool the two — see `src/backtest/metrics.ts`.
 */
export const ProvenanceSchema = z.enum(["pre_registered", "reconstructed"]);
export type ContractProvenance = z.infer<typeof ProvenanceSchema>;

export const AmendmentSchema = z.object({
  reason: z.string().min(1),
  author: z.string().min(1),
  at: z.string().min(1),
});
export type Amendment = z.infer<typeof AmendmentSchema>;

export const ContractSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  /** Excluded from the contract hash — identity is not content. */
  contract_id: z.string().min(1),
  objective: z.string().min(1),
  provenance: ProvenanceSchema.default("pre_registered"),

  repo: z.object({
    remote: z.string().default(""),
    /** The tree the implementing agent starts from. Inside the hash. */
    base_commit: z.string().min(1),
  }),

  created_at: z.string().min(1),
  compiler: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    mode: z.enum(["manual", "assisted"]),
  }),

  criteria: z.array(CriterionSchema).min(1),

  /** `contract_hash` of the contract this one replaces, if any. */
  supersedes: z.string().nullable().default(null),
  amendment: AmendmentSchema.nullable().default(null),
});
export type Contract = z.infer<typeof ContractSchema>;

/** A contract that has been hashed and written to the ledger. */
export interface FrozenContract extends Contract {
  readonly contract_hash: string;
}

/** Fields excluded from the contract hash. Identity and the digest itself. */
export const CONTRACT_HASH_EXCLUDED = ["contract_id", "contract_hash"] as const;

/** Every requirement across every criterion, flattened. */
export function allRequirements(
  contract: Contract,
): Array<{ criterion: Criterion; requirement: Requirement }> {
  return contract.criteria.flatMap((criterion) =>
    criterion.evidence_requirements.map((requirement) => ({ criterion, requirement })),
  );
}
