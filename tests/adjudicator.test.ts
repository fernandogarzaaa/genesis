import { describe, expect, it } from "vitest";
import { adjudicate } from "../src/adjudicator/index.js";
import { CLEAN_PRE_REGISTRATION, criterion, evidence, frozen, requirement } from "./helpers.js";

function verdictOf(
  contractOverrides: Parameters<typeof frozen>[0],
  records: ReturnType<typeof evidence>[],
  preReg = CLEAN_PRE_REGISTRATION,
) {
  const contract = frozen(contractOverrides);
  return adjudicate({
    contract,
    evidence: records.map((r) => ({ ...r, contract_hash: contract.contract_hash })),
    preRegistration: preReg,
  });
}

describe("adjudicate — the happy path", () => {
  it("returns SHIP when every binding criterion is satisfied", () => {
    const result = verdictOf({}, [evidence({ observation: { failed: 0 } })]);
    expect(result.verdict).toBe("SHIP");
    expect(result.counts.satisfied).toBe(1);
  });
});

describe("adjudicate — mechanical failure is terminal", () => {
  it("returns NOT_READY when an expectation is violated", () => {
    const result = verdictOf({}, [evidence({ observation: { failed: 3 } })]);
    expect(result.verdict).toBe("NOT_READY");
    expect(result.criteria[0]?.state).toBe("FAILED");
  });

  it("cites the observed value against the expected one", () => {
    const result = verdictOf({}, [evidence({ observation: { failed: 3 } })]);
    expect(result.criteria[0]?.requirements[0]?.reason).toContain("3");
  });

  // The rule with no upward edge.
  it("cannot be lifted out of FAILED by passing judgmental evidence", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ id: "C1#0", kind: "mechanical" }),
              requirement({
                id: "C1#1",
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      },
      [
        evidence({ requirement_id: "C1#0", observation: { failed: 2 } }),
        evidence({
          requirement_id: "C1#1",
          kind: "judgmental",
          observation: { satisfies_intent: true },
        }),
      ],
    );

    expect(result.verdict).toBe("NOT_READY");
    expect(result.criteria[0]?.state).toBe("FAILED");
  });

  it("outranks an undecidable expectation in the same requirement", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({
                expect: [
                  { metric: "failed", op: "equals", value: 0 },
                  { metric: "never_reported", op: "equals", value: 1 },
                ],
              }),
            ],
          }),
        ],
      },
      [evidence({ observation: { failed: 4 } })],
    );
    expect(result.verdict).toBe("NOT_READY");
  });
});

describe("adjudicate — absence of evidence is never acceptability", () => {
  it("returns HUMAN_REVIEW when no evidence was collected at all", () => {
    const result = verdictOf({}, []);
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("UNPROVEN");
  });

  it("returns HUMAN_REVIEW when the collector errored", () => {
    const result = verdictOf({}, [evidence({ status: "error", observation: {}, detail: ["boom"] })]);
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.requirements[0]?.reason).toContain("boom");
  });

  it("returns HUMAN_REVIEW when the observation lacks the expected metric", () => {
    const result = verdictOf({}, [evidence({ observation: { something_else: 1 } })]);
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("UNPROVEN");
  });

  it("treats a flaky collector as unproven rather than failed", () => {
    // Blocking a merge on a coin flip is worse than escalating it.
    const result = verdictOf({}, [evidence({ status: "flaky", observation: { failed: 1 } })]);
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("UNPROVEN");
  });
});

describe("adjudicate — judgmental evidence cannot be terminal in either direction", () => {
  it("cannot satisfy a criterion on its own", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      },
      [evidence({ kind: "judgmental", observation: { satisfies_intent: true } })],
    );

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("UNPROVEN");
  });

  it("cannot force NOT_READY — it escalates to HUMAN_REVIEW instead", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ id: "C1#0", kind: "mechanical" }),
              requirement({
                id: "C1#1",
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      },
      [
        evidence({ requirement_id: "C1#0", observation: { failed: 0 } }),
        evidence({
          requirement_id: "C1#1",
          kind: "judgmental",
          observation: { satisfies_intent: false },
        }),
      ],
    );

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("CONTESTED");
  });

  /**
   * The removal test, as a monotonicity property.
   *
   * Deleting the judgmental tier must never make Genesis *more* permissive. If
   * turning the LLM off loosened the gate, the LLM would be load-bearing for
   * strictness — and Genesis would have become the AI code reviewer it was
   * built to replace. The property is one-directional on purpose: removal is
   * allowed to make the verdict stricter (an undeclarable criterion becomes
   * unproven), never laxer.
   */
  it("removing judgmental evidence never loosens the verdict", () => {
    const permissiveness = { NOT_READY: 0, HUMAN_REVIEW: 1, SHIP: 2 } as const;

    const spec = {
      criteria: [
        criterion({
          evidence_requirements: [
            requirement({ id: "C1#0", kind: "mechanical" }),
            requirement({
              id: "C1#1",
              kind: "judgmental",
              collector: "command",
              expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
            }),
          ],
        }),
      ],
    };

    for (const mechanical of [0, 5]) {
      for (const judgment of [true, false]) {
        const withJudgment = verdictOf(spec, [
          evidence({ requirement_id: "C1#0", observation: { failed: mechanical } }),
          evidence({ requirement_id: "C1#1", kind: "judgmental", observation: { satisfies_intent: judgment } }),
        ]);
        const without = verdictOf(spec, [
          evidence({ requirement_id: "C1#0", observation: { failed: mechanical } }),
        ]);

        expect(permissiveness[without.verdict]).toBeLessThanOrEqual(
          permissiveness[withJudgment.verdict],
        );
      }
    }
  });

  it("leaves a criterion unproven when a declared judgmental check did not run", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ id: "C1#0", kind: "mechanical" }),
              requirement({
                id: "C1#1",
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      },
      [evidence({ requirement_id: "C1#0", observation: { failed: 0 } })],
    );

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.state).toBe("UNPROVEN");
  });

  it("satisfies a criterion when mechanical and judgmental evidence both pass", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ id: "C1#0", kind: "mechanical" }),
              requirement({
                id: "C1#1",
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "satisfies_intent", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      },
      [
        evidence({ requirement_id: "C1#0", observation: { failed: 0 } }),
        evidence({ requirement_id: "C1#1", kind: "judgmental", observation: { satisfies_intent: true } }),
      ],
    );

    expect(result.verdict).toBe("SHIP");
  });
});

describe("adjudicate — self-authored evidence", () => {
  it("refuses to let a test written in this diff satisfy its own criterion", () => {
    const result = verdictOf({}, [
      evidence({ observation: { failed: 0, status: "pass", evidence_authored_in_diff: true } }),
    ]);

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.criteria[0]?.requirements[0]?.reason).toContain("authored in the diff");
  });

  it("accepts evidence from a test that predates the diff", () => {
    const result = verdictOf({}, [
      evidence({ observation: { failed: 0, evidence_authored_in_diff: false } }),
    ]);
    expect(result.verdict).toBe("SHIP");
  });
});

describe("adjudicate — pre-registration", () => {
  it("will not SHIP when the contract was frozen after work began", () => {
    const result = verdictOf({}, [evidence()], {
      ...CLEAN_PRE_REGISTRATION,
      frozen_before_first_commit: false,
    });
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.rationale.join(" ")).toContain("frozen after implementation began");
  });

  it("will not SHIP when the contract was amended mid-flight", () => {
    const result = verdictOf({}, [evidence()], {
      ...CLEAN_PRE_REGISTRATION,
      amended_after_first_commit: true,
    });
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.rationale.join(" ")).toContain("amended after implementation began");
  });

  it("will not SHIP when the base commit is not an ancestor of head", () => {
    const result = verdictOf({}, [evidence()], {
      ...CLEAN_PRE_REGISTRATION,
      base_is_ancestor: false,
    });
    expect(result.verdict).toBe("HUMAN_REVIEW");
  });

  it("will not SHIP when pre-registration could not be established", () => {
    const result = verdictOf({}, [evidence()], {
      determined: false,
      base_is_ancestor: false,
      frozen_before_first_commit: false,
      amended_after_first_commit: false,
    });
    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.rationale.join(" ")).toContain("could not be established");
  });

  // A failure is a failure regardless of whether the paperwork was in order.
  it("still reports NOT_READY when evidence fails and pre-registration is broken", () => {
    const result = verdictOf({}, [evidence({ observation: { failed: 1 } })], {
      ...CLEAN_PRE_REGISTRATION,
      frozen_before_first_commit: false,
    });
    expect(result.verdict).toBe("NOT_READY");
  });
});

describe("adjudicate — non-binding criteria", () => {
  it("records advisories without letting them change the verdict", () => {
    const result = verdictOf(
      {
        criteria: [
          criterion({ id: "C1" }),
          criterion({
            id: "ADV",
            binding: false,
            evidence_requirements: [requirement({ id: "ADV#0" })],
          }),
        ],
      },
      [
        evidence({ criterion_id: "C1", requirement_id: "C1#0", observation: { failed: 0 } }),
        evidence({ criterion_id: "ADV", requirement_id: "ADV#0", observation: { failed: 9 } }),
      ],
    );

    expect(result.verdict).toBe("SHIP");
    expect(result.criteria.find((c) => c.criterion_id === "ADV")?.state).toBe("FAILED");
    expect(result.counts.failed).toBe(0);
  });
});

describe("adjudicate — determinism", () => {
  it("is invariant to the order evidence arrives in", () => {
    const spec = {
      criteria: [
        criterion({
          evidence_requirements: [
            requirement({ id: "C1#0" }),
            requirement({ id: "C1#1", collector: "typecheck", expect: [{ metric: "errors", op: "equals", value: 0 }] }),
          ],
        }),
      ],
    };
    const a = evidence({ requirement_id: "C1#0", observation: { failed: 0 } });
    const b = evidence({ requirement_id: "C1#1", observation: { errors: 0 } });

    const forward = verdictOf(spec, [a, b]);
    const backward = verdictOf(spec, [b, a]);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it("produces byte-identical output across repeated calls", () => {
    const contract = frozen();
    const records = [evidence({ contract_hash: contract.contract_hash })];
    const input = { contract, evidence: records, preRegistration: CLEAN_PRE_REGISTRATION };

    expect(JSON.stringify(adjudicate(input))).toBe(JSON.stringify(adjudicate(input)));
  });
});
