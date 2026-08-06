import { describe, expect, it } from "vitest";
import {
  amendContract,
  computeContractHash,
  draftContract,
  freezeContract,
  normalizeContract,
  verifyContractHash,
} from "../src/contract/freeze.js";
import { validateContract } from "../src/contract/validate.js";
import { contract, criterion, requirement } from "./helpers.js";

const COLLECTORS = ["test", "typecheck", "coverage", "lint", "diff", "command", "eve"];

describe("freezing", () => {
  it("produces a hash independent of key insertion order", () => {
    const a = contract();
    const b = { ...contract(), criteria: [...a.criteria] };
    expect(computeContractHash(a)).toBe(computeContractHash(b));
  });

  it("excludes contract_id, since identity is not content", () => {
    const a = contract({ contract_id: "id-one" });
    const b = contract({ contract_id: "id-two" });
    expect(computeContractHash(a)).toBe(computeContractHash(b));
  });

  it("changes when a criterion changes", () => {
    const a = contract();
    const b = contract({ criteria: [criterion({ statement: "Something else." })] });
    expect(computeContractHash(a)).not.toBe(computeContractHash(b));
  });

  it("changes when the base commit changes", () => {
    const a = contract();
    const b = contract({ repo: { remote: "", base_commit: "c".repeat(40) } });
    expect(computeContractHash(a)).not.toBe(computeContractHash(b));
  });

  it("changes when a threshold is loosened", () => {
    const a = contract();
    const b = contract({
      criteria: [
        criterion({
          evidence_requirements: [requirement({ expect: [{ metric: "failed", op: "lte", value: 5 }] })],
        }),
      ],
    });
    expect(computeContractHash(a)).not.toBe(computeContractHash(b));
  });

  it("verifies its own hash", () => {
    const f = freezeContract(contract());
    expect(verifyContractHash(f)).toBe(true);
  });

  it("detects post-freeze modification", () => {
    const f = freezeContract(contract());
    const tampered = { ...f, objective: "something else entirely" };
    expect(verifyContractHash(tampered)).toBe(false);
  });

  it("assigns stable requirement ids before hashing", () => {
    const normalized = normalizeContract(
      contract({
        criteria: [
          criterion({
            id: "AUTH",
            evidence_requirements: [
              { ...requirement(), id: "" },
              { ...requirement(), id: "", collector: "typecheck" },
            ],
          }),
        ],
      }),
    );
    const ids = normalized.criteria[0]?.evidence_requirements.map((r) => r.id);
    expect(ids).toEqual(["AUTH#0", "AUTH#1"]);
  });
});

describe("amendment", () => {
  it("supersedes the prior hash without mutating it", () => {
    const original = freezeContract(contract());
    const amended = amendContract(
      original,
      { objective: "A revised objective." },
      { reason: "scope changed", author: "fernando", at: "2026-08-03T00:00:00.000Z" },
    );

    expect(amended.supersedes).toBe(original.contract_hash);
    expect(amended.contract_hash).not.toBe(original.contract_hash);
    expect(original.objective).toBe("Keep the suite green.");
    expect(verifyContractHash(amended)).toBe(true);
  });

  it("does not carry the prior hash into the new content", () => {
    const original = freezeContract(contract());
    const amended = amendContract(
      original,
      {},
      { reason: "r", author: "a", at: "2026-08-03T00:00:00.000Z" },
    );
    expect(computeContractHash(amended)).toBe(amended.contract_hash);
  });
});

describe("validation — falsifiability", () => {
  it("accepts a well-formed contract", () => {
    const result = validateContract(contract(), COLLECTORS);
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown collector", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ evidence_requirements: [requirement({ collector: "vibes" })] })] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('unknown collector "vibes"');
  });

  it("rejects a criterion with no evidence requirements", () => {
    const result = validateContract(
      contract({ criteria: [{ ...criterion(), evidence_requirements: [] }] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a requirement with no expectations", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ evidence_requirements: [{ ...requirement(), expect: [] }] })] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });

  // The most likely way a contract gets quietly weakened. Two layers reject it:
  // zod's `z.number()` refuses non-finite values first, and `checkExpectation`
  // backstops that for any caller reaching the predicate checks directly.
  it("rejects a trivially-satisfied non-finite bound", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ expect: [{ metric: "failed", op: "lte", value: Number.POSITIVE_INFINITY }] }),
            ],
          }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path.includes("expect"))).toBe(true);
  });

  it("rejects an empty one_of, which nothing can satisfy", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({ evidence_requirements: [requirement({ expect: [{ metric: "status", op: "one_of", value: [] }] })] }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects contradictory bounds on one metric", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({
                expect: [
                  { metric: "coverage", op: "gte", value: 90 },
                  { metric: "coverage", op: "lte", value: 50 },
                ],
              }),
            ],
          }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("contradictory bounds"))).toBe(true);
  });

  it("rejects contradictory equals on one metric", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({
                expect: [
                  { metric: "status_code", op: "equals", value: 401 },
                  { metric: "status_code", op: "equals", value: 200 },
                ],
              }),
            ],
          }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a contract in which nothing is binding", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ binding: false })] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("no binding criteria"))).toBe(true);
  });

  it("rejects duplicate criterion ids", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ id: "DUP" }), criterion({ id: "DUP" })] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a numeric operator given a string bound", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({ evidence_requirements: [requirement({ expect: [{ metric: "n", op: "lte", value: "many" }] })] }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(false);
  });
});

describe("validation — advisories", () => {
  it("warns about hedging language but does not block", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ statement: "Users can log in securely." })] }),
      COLLECTORS,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.message.includes("unfalsifiable prose"))).toBe(true);
  });

  it("warns when the failure condition merely restates the criterion", () => {
    const result = validateContract(
      contract({ criteria: [criterion({ statement: "It works.", failure_condition: "It works." })] }),
      COLLECTORS,
    );
    expect(result.warnings.some((w) => w.message.includes("restates"))).toBe(true);
  });

  it("warns that judgmental evidence cannot decide anything", () => {
    const result = validateContract(
      contract({
        criteria: [
          criterion({
            evidence_requirements: [
              requirement({ kind: "mechanical", id: "C1#0" }),
              requirement({
                id: "C1#1",
                kind: "judgmental",
                collector: "command",
                expect: [{ metric: "ok", op: "equals", value: true }],
              }),
            ],
          }),
        ],
      }),
      COLLECTORS,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.message.includes("cannot satisfy a criterion"))).toBe(true);
  });
});

describe("draft", () => {
  it("scaffolds a contract that validates but is obviously a placeholder", () => {
    const draft = draftContract({ objective: "Do the thing", baseCommit: "a".repeat(40) });
    const result = validateContract(draft, COLLECTORS);
    expect(result.ok).toBe(true);
    expect(draft.criteria[0]?.id).toBe("EXAMPLE-001");
  });
});
