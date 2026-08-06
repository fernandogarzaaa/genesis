/**
 * The Adjudicator.
 *
 * A pure, total function of (frozen contract, admissible evidence,
 * pre-registration facts) → verdict. No I/O, no clock, no network, no
 * randomness, no filesystem. Given the same inputs it returns a byte-identical
 * verdict today and in two years when the ledger is replayed to recalibrate.
 *
 * That property is not a nicety. It is what separates an audit layer from an AI
 * code reviewer, and it is enforced by `tests/adjudicator.purity.test.ts`,
 * which fails if anything in this directory imports a value from outside the
 * pure core.
 *
 * The lattice has one rule with no upward edge: a mechanical or behavioral
 * violation is terminal. No judgmental evidence, confidence score, or
 * subsequent collector can move a criterion out of FAILED.
 */

import type { Contract, Criterion, FrozenContract, Requirement } from "../contract/schema.js";
import type { Evidence } from "../evidence/envelope.js";
import { evaluateAll, type ExpectationResult } from "./expect.js";

export const ADJUDICATOR_VERSION = "0.1.0";

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Facts about the relationship between the contract and the diff, computed
 * impurely by the caller and passed in as data so the Adjudicator stays pure.
 * Recorded in the ledger alongside the verdict.
 */
export interface PreRegistrationFacts {
  /** False when git could not establish these facts (shallow clone, no history). */
  readonly determined: boolean;
  /** `contract.repo.base_commit` is an ancestor of the head being graded. */
  readonly base_is_ancestor: boolean;
  /** The contract was frozen before the earliest commit in the diff. */
  readonly frozen_before_first_commit: boolean;
  /** An amendment landed after implementation began. */
  readonly amended_after_first_commit: boolean;
}

export interface AdjudicationInput {
  readonly contract: FrozenContract;
  readonly evidence: readonly Evidence[];
  readonly preRegistration: PreRegistrationFacts;
}

// ── Outputs ─────────────────────────────────────────────────────────────────

export type Verdict = "SHIP" | "NOT_READY" | "HUMAN_REVIEW";

export type RequirementState = "satisfied" | "violated" | "unproven";

export type CriterionState = "SATISFIED" | "FAILED" | "UNPROVEN" | "CONTESTED";

export interface RequirementFinding {
  readonly requirement_id: string;
  readonly collector: string;
  readonly kind: Requirement["kind"];
  readonly state: RequirementState;
  readonly reason: string;
  readonly evidence_id: string | null;
  readonly artifact_digest: string | null;
  readonly expectations: readonly ExpectationResult[];
}

export interface CriterionFinding {
  readonly criterion_id: string;
  readonly statement: string;
  readonly binding: boolean;
  readonly state: CriterionState;
  readonly requirements: readonly RequirementFinding[];
}

export interface Adjudication {
  readonly verdict: Verdict;
  readonly contract_hash: string;
  readonly adjudicator_version: string;
  readonly criteria: readonly CriterionFinding[];
  /** Why the verdict is what it is, in the order the rules fired. */
  readonly rationale: readonly string[];
  readonly counts: {
    readonly satisfied: number;
    readonly failed: number;
    readonly unproven: number;
    readonly contested: number;
  };
}

// ── The function ────────────────────────────────────────────────────────────

export function adjudicate(input: AdjudicationInput): Adjudication {
  const { contract, preRegistration } = input;

  // Sorted so the result cannot depend on collector completion order. Inlined
  // rather than imported: the pure core takes no runtime dependency on any
  // module outside itself, and `tests/adjudicator.purity.test.ts` enforces that.
  const evidence = [...input.evidence].sort(byIdentity);
  const byRequirement = new Map<string, Evidence>();
  for (const record of evidence) {
    // Deterministic tie-break: the last record wins under the sort above, which
    // puts the highest evidence_id last. Duplicates are a collector bug, but
    // the resolution must still be reproducible.
    byRequirement.set(record.requirement_id, record);
  }

  const criteria = contract.criteria.map((criterion) =>
    evaluateCriterion(criterion, byRequirement),
  );

  const binding = criteria.filter((c) => c.binding);
  const counts = {
    satisfied: binding.filter((c) => c.state === "SATISFIED").length,
    failed: binding.filter((c) => c.state === "FAILED").length,
    unproven: binding.filter((c) => c.state === "UNPROVEN").length,
    contested: binding.filter((c) => c.state === "CONTESTED").length,
  };

  const rationale: string[] = [];
  let verdict: Verdict;

  if (counts.failed > 0) {
    verdict = "NOT_READY";
    rationale.push(
      `${counts.failed} binding criterion(s) have failing mechanical or behavioral evidence: ` +
        binding.filter((c) => c.state === "FAILED").map((c) => c.criterion_id).join(", "),
    );
  } else if (counts.unproven > 0 || counts.contested > 0) {
    verdict = "HUMAN_REVIEW";
    if (counts.unproven > 0) {
      rationale.push(
        `${counts.unproven} binding criterion(s) could not be proven: ` +
          binding.filter((c) => c.state === "UNPROVEN").map((c) => c.criterion_id).join(", ") +
          ". Absence of evidence is never evidence of acceptability.",
      );
    }
    if (counts.contested > 0) {
      rationale.push(
        `${counts.contested} binding criterion(s) are contested by judgmental evidence: ` +
          binding.filter((c) => c.state === "CONTESTED").map((c) => c.criterion_id).join(", ") +
          ". Judgmental evidence can raise a hand but cannot render a verdict.",
      );
    }
  } else {
    const preRegIssues = checkPreRegistration(preRegistration, contract);
    if (preRegIssues.length > 0) {
      verdict = "HUMAN_REVIEW";
      rationale.push(...preRegIssues);
    } else {
      verdict = "SHIP";
      rationale.push(
        `All ${counts.satisfied} binding criteria are satisfied by admissible evidence, ` +
          "and the contract was frozen before implementation began.",
      );
    }
  }

  return {
    verdict,
    contract_hash: contract.contract_hash,
    adjudicator_version: ADJUDICATOR_VERSION,
    criteria,
    rationale,
    counts,
  };
}

function byIdentity(a: Evidence, b: Evidence): number {
  if (a.criterion_id !== b.criterion_id) return a.criterion_id < b.criterion_id ? -1 : 1;
  if (a.requirement_id !== b.requirement_id) return a.requirement_id < b.requirement_id ? -1 : 1;
  if (a.evidence_id !== b.evidence_id) return a.evidence_id < b.evidence_id ? -1 : 1;
  return 0;
}

// ── Criterion evaluation ────────────────────────────────────────────────────

function evaluateCriterion(
  criterion: Criterion,
  byRequirement: ReadonlyMap<string, Evidence>,
): CriterionFinding {
  const requirements = criterion.evidence_requirements.map((requirement) =>
    evaluateRequirement(requirement, byRequirement.get(requirement.id)),
  );

  const state = deriveCriterionState(requirements);

  return {
    criterion_id: criterion.id,
    statement: criterion.statement,
    binding: criterion.binding,
    state,
    requirements,
  };
}

function deriveCriterionState(requirements: readonly RequirementFinding[]): CriterionState {
  const decisive = requirements.filter((r) => r.kind !== "judgmental");
  const judgmental = requirements.filter((r) => r.kind === "judgmental");

  // Terminal. Nothing below can lift a criterion out of this.
  if (decisive.some((r) => r.state === "violated")) return "FAILED";

  if (decisive.some((r) => r.state === "unproven")) return "UNPROVEN";

  // A criterion backed only by judgmental evidence cannot be satisfied. An LLM
  // may not certify a criterion any more than it may fail one.
  if (decisive.length === 0) return "UNPROVEN";

  if (judgmental.some((r) => r.state === "violated")) return "CONTESTED";

  // A declared judgmental requirement that could not be collected leaves the
  // criterion unproven rather than being quietly ignored. Without this, turning
  // the judgmental collector off would make Genesis *more* permissive — the LLM
  // would be load-bearing for strictness, which is the dependency the whole
  // design is trying not to have. See the monotonicity test in
  // tests/adjudicator.test.ts.
  if (judgmental.some((r) => r.state === "unproven")) return "UNPROVEN";

  return "SATISFIED";
}

function evaluateRequirement(
  requirement: Requirement,
  record: Evidence | undefined,
): RequirementFinding {
  const base = {
    requirement_id: requirement.id,
    collector: requirement.collector,
    kind: requirement.kind,
  } as const;

  if (!record) {
    return {
      ...base,
      state: "unproven",
      reason: `no admissible evidence was collected for "${requirement.collector}"`,
      evidence_id: null,
      artifact_digest: null,
      expectations: [],
    };
  }

  const cite = { evidence_id: record.evidence_id, artifact_digest: record.artifact_digest };

  if (record.status !== "collected") {
    const reason =
      record.status === "error"
        ? `collector errored: ${record.detail[0] ?? "no detail"}`
        : record.status === "flaky"
          ? "collector produced different results on re-run; a coin flip cannot block a merge"
          : "collector did not run";
    return { ...base, ...cite, state: "unproven", reason, expectations: [] };
  }

  // R1 mitigation: a criterion whose only passing evidence comes from a test
  // introduced or modified in the diff under evaluation is self-certifying.
  // It caps at unproven rather than satisfying anything.
  if (record.observation["evidence_authored_in_diff"] === true) {
    return {
      ...base,
      ...cite,
      state: "unproven",
      reason:
        "the evidence for this criterion was authored in the diff under evaluation; " +
        "self-authored proof cannot satisfy a criterion",
      expectations: [],
    };
  }

  const { outcome, results } = evaluateAll(requirement.expect, record.observation);

  const state: RequirementState =
    outcome === "held" ? "satisfied" : outcome === "violated" ? "violated" : "unproven";

  const reason =
    outcome === "held"
      ? results.map((r) => r.explanation).join("; ")
      : outcome === "violated"
        ? results.filter((r) => r.outcome === "violated").map((r) => r.explanation).join("; ")
        : results.filter((r) => r.outcome === "undecidable").map((r) => r.explanation).join("; ");

  return { ...base, ...cite, state, reason, expectations: results };
}

// ── Pre-registration ────────────────────────────────────────────────────────

function checkPreRegistration(
  facts: PreRegistrationFacts,
  contract: Contract,
): string[] {
  const issues: string[] = [];

  if (!facts.determined) {
    issues.push(
      "Pre-registration could not be established (no usable git history). " +
        "Genesis will not certify a contract it cannot prove came first.",
    );
    return issues;
  }

  if (!facts.base_is_ancestor) {
    issues.push(
      `The contract's base commit (${short(contract.repo.base_commit)}) is not an ancestor of the ` +
        "head being graded, so the contract and the work are not on the same line of history.",
    );
  }

  if (!facts.frozen_before_first_commit) {
    issues.push(
      "The contract was frozen after implementation began. Grading against a contract " +
        "written once the answer was known is not pre-registration.",
    );
  }

  if (facts.amended_after_first_commit) {
    issues.push(
      "The contract was amended after implementation began. The amendment is recorded and " +
        "the chain is intact, but Genesis will not say SHIP against a goalpost that moved mid-flight.",
    );
  }

  return issues;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}
