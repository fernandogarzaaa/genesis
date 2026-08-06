/**
 * Expectation evaluation. Pure, total, no I/O.
 *
 * Returns `null` — not `false` — when the observation lacks the metric. The
 * distinction is load-bearing: "the observation says 200 and we wanted 401" is
 * a failure, while "the collector never reported a status code" is an unproven
 * criterion. Collapsing the second into the first would let a broken collector
 * read as a broken repository.
 */

import type { Expectation } from "../contract/schema.js";
import type { ObservedValue } from "../evidence/envelope.js";

export type ExpectationOutcome = "held" | "violated" | "undecidable";

export interface ExpectationResult {
  readonly outcome: ExpectationOutcome;
  readonly expectation: Expectation;
  readonly observed: ObservedValue | undefined;
  readonly explanation: string;
}

export function evaluateExpectation(
  expectation: Expectation,
  observation: Readonly<Record<string, ObservedValue>>,
): ExpectationResult {
  const observed = Object.prototype.hasOwnProperty.call(observation, expectation.metric)
    ? observation[expectation.metric]
    : undefined;

  if (observed === undefined || observed === null) {
    return {
      outcome: "undecidable",
      expectation,
      observed,
      explanation: `no observation for "${expectation.metric}"`,
    };
  }

  const { op, value } = expectation;

  if (op === "one_of") {
    const set = Array.isArray(value) ? value : [value];
    const held = set.some((candidate) => candidate === observed);
    return result(held, expectation, observed, `${fmt(observed)} ${held ? "in" : "not in"} {${set.map(fmt).join(", ")}}`);
  }

  if (op === "equals" || op === "not_equals") {
    if (Array.isArray(value)) {
      return undecidable(expectation, observed, `operator "${op}" cannot compare against an array`);
    }
    const equal = observed === value;
    const held = op === "equals" ? equal : !equal;
    return result(held, expectation, observed, `${fmt(observed)} ${op === "equals" ? "==" : "!="} ${fmt(value)} is ${held}`);
  }

  // Numeric comparisons.
  if (typeof observed !== "number" || typeof value !== "number") {
    return undecidable(
      expectation,
      observed,
      `operator "${op}" needs numbers, got ${typeof observed} and ${typeof value}`,
    );
  }

  const held =
    op === "lt" ? observed < value
    : op === "lte" ? observed <= value
    : op === "gt" ? observed > value
    : observed >= value;

  return result(held, expectation, observed, `${observed} ${symbol(op)} ${value} is ${held}`);
}

/** All expectations must hold. Any undecidable makes the whole set undecidable. */
export function evaluateAll(
  expectations: readonly Expectation[],
  observation: Readonly<Record<string, ObservedValue>>,
): { outcome: ExpectationOutcome; results: readonly ExpectationResult[] } {
  const results = expectations.map((e) => evaluateExpectation(e, observation));

  // A violation is a definite fact and outranks a gap in the observation: if
  // one expectation is provably broken, the criterion has failed regardless of
  // what else could not be checked.
  if (results.some((r) => r.outcome === "violated")) return { outcome: "violated", results };
  if (results.some((r) => r.outcome === "undecidable")) return { outcome: "undecidable", results };
  return { outcome: "held", results };
}

function result(
  held: boolean,
  expectation: Expectation,
  observed: ObservedValue | undefined,
  explanation: string,
): ExpectationResult {
  return { outcome: held ? "held" : "violated", expectation, observed, explanation };
}

function undecidable(
  expectation: Expectation,
  observed: ObservedValue | undefined,
  explanation: string,
): ExpectationResult {
  return { outcome: "undecidable", expectation, observed, explanation };
}

function symbol(op: string): string {
  return op === "lt" ? "<" : op === "lte" ? "<=" : op === "gt" ? ">" : ">=";
}

function fmt(v: ObservedValue | string | number | boolean): string {
  return typeof v === "string" ? `"${v}"` : String(v);
}
