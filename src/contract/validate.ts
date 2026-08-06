/**
 * Contract validation — falsifiability is enforced here, not encouraged in docs.
 *
 * The rejection of `"Users can login securely"` is structural rather than
 * linguistic: a criterion is admissible only if it carries at least one
 * evidence requirement naming a registered collector, and at least one
 * expectation that is decidable and non-trivial. A vague sentence with real
 * evidence behind it is fine; a precise sentence with nothing checkable behind
 * it is not.
 */

import {
  ContractSchema,
  type Contract,
  type Expectation,
  allRequirements,
} from "./schema.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly ValidationIssue[];
  /** Advisory only. Never blocks freezing. */
  readonly warnings: readonly ValidationIssue[];
  readonly contract?: Contract;
}

const NUMERIC_OPS = new Set(["lt", "lte", "gt", "gte"]);

/** Hedging language that usually signals an unfalsifiable statement. */
const HEDGES = [
  "should probably", "as appropriate", "properly", "correctly", "securely",
  "robustly", "gracefully", "reasonable", "user-friendly", "intuitive",
  "well-tested", "clean", "good", "better", "improved", "optimized",
];

export function validateContract(
  input: unknown,
  knownCollectors: readonly string[],
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = ContractSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ path: issue.path.join(".") || "$", message: issue.message });
    }
    return { ok: false, errors, warnings };
  }

  const contract = parsed.data;

  // ── Identity ──────────────────────────────────────────────────────────────

  const criterionIds = new Set<string>();
  for (const criterion of contract.criteria) {
    if (criterionIds.has(criterion.id)) {
      errors.push({
        path: `criteria.${criterion.id}`,
        message: `duplicate criterion id "${criterion.id}"`,
      });
    }
    criterionIds.add(criterion.id);
  }

  const requirementIds = new Set<string>();
  for (const { criterion, requirement } of allRequirements(contract)) {
    if (requirementIds.has(requirement.id)) {
      errors.push({
        path: `criteria.${criterion.id}.evidence_requirements.${requirement.id}`,
        message: `duplicate requirement id "${requirement.id}"`,
      });
    }
    requirementIds.add(requirement.id);
  }

  // ── A contract that cannot fail is not a contract ─────────────────────────

  if (!contract.criteria.some((c) => c.binding)) {
    errors.push({
      path: "criteria",
      message:
        "no binding criteria — every criterion is advisory, so this contract can never yield NOT READY",
    });
  }

  // ── Requirements ──────────────────────────────────────────────────────────

  for (const { criterion, requirement } of allRequirements(contract)) {
    const base = `criteria.${criterion.id}.evidence_requirements.${requirement.id}`;

    if (!knownCollectors.includes(requirement.collector)) {
      errors.push({
        path: `${base}.collector`,
        message:
          `unknown collector "${requirement.collector}" ` +
          `(registered: ${knownCollectors.join(", ") || "none"})`,
      });
    }

    if (requirement.kind === "judgmental") {
      warnings.push({
        path: `${base}.kind`,
        message:
          "judgmental evidence cannot satisfy a criterion on its own and cannot fail one; " +
          "it can only escalate an otherwise-clean result to HUMAN REVIEW",
      });
    }

    for (const [i, expectation] of requirement.expect.entries()) {
      checkExpectation(expectation, `${base}.expect[${i}]`, errors);
    }

    checkContradictions(requirement.expect, `${base}.expect`, errors);
  }

  // ── Advisories ────────────────────────────────────────────────────────────

  for (const criterion of contract.criteria) {
    const lower = criterion.statement.toLowerCase();
    const hit = HEDGES.find((h) => lower.includes(h));
    if (hit) {
      warnings.push({
        path: `criteria.${criterion.id}.statement`,
        message:
          `statement contains "${hit}", which is usually unfalsifiable prose. ` +
          "The attached evidence requirements are what will actually be checked — " +
          "make sure they say what this sentence means.",
      });
    }
    if (criterion.statement.trim() === criterion.failure_condition.trim()) {
      warnings.push({
        path: `criteria.${criterion.id}.failure_condition`,
        message: "failure_condition merely restates the criterion; describe an observable failing state",
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    contract: errors.length === 0 ? contract : undefined,
  };
}

function checkExpectation(
  expectation: Expectation,
  path: string,
  errors: ValidationIssue[],
): void {
  const { op, value } = expectation;

  if (op === "one_of") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: '"one_of" requires an array value' });
    } else if (value.length === 0) {
      errors.push({ path, message: '"one_of" with an empty set can never be satisfied' });
    }
    return;
  }

  if (Array.isArray(value)) {
    errors.push({ path, message: `operator "${op}" does not take an array value` });
    return;
  }

  if (NUMERIC_OPS.has(op)) {
    if (typeof value !== "number") {
      errors.push({ path, message: `operator "${op}" requires a numeric value` });
    } else if (!Number.isFinite(value)) {
      // The trivially-true expectation: `lte: Infinity` passes for every
      // observation, which is a criterion that cannot fail wearing a criterion's
      // clothes. This is the single most likely way a contract gets quietly
      // weakened, so it is an error rather than a warning.
      errors.push({
        path,
        message: `non-finite bound (${String(value)}) is trivially satisfied and cannot falsify anything`,
      });
    }
  }
}

/** Catch expectations on one metric that no observation could satisfy at once. */
function checkContradictions(
  expectations: readonly Expectation[],
  path: string,
  errors: ValidationIssue[],
): void {
  const byMetric = new Map<string, Expectation[]>();
  for (const e of expectations) {
    const list = byMetric.get(e.metric);
    if (list) list.push(e);
    else byMetric.set(e.metric, [e]);
  }

  for (const [metric, group] of byMetric) {
    const equals = group.filter((e) => e.op === "equals");
    if (equals.length > 1) {
      const distinct = new Set(equals.map((e) => JSON.stringify(e.value)));
      if (distinct.size > 1) {
        errors.push({
          path,
          message: `contradictory expectations on "${metric}": equals ${[...distinct].join(" and ")}`,
        });
      }
    }

    const lowerBounds = group.filter((e) => e.op === "gte" || e.op === "gt");
    const upperBounds = group.filter((e) => e.op === "lte" || e.op === "lt");
    for (const lo of lowerBounds) {
      for (const hi of upperBounds) {
        if (typeof lo.value === "number" && typeof hi.value === "number" && lo.value > hi.value) {
          errors.push({
            path,
            message: `contradictory bounds on "${metric}": ${lo.op} ${lo.value} and ${hi.op} ${hi.value}`,
          });
        }
      }
    }
  }
}
