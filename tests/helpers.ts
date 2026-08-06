import type { PreRegistrationFacts } from "../src/adjudicator/index.js";
import type {
  Contract,
  Criterion,
  Expectation,
  FrozenContract,
  Requirement,
} from "../src/contract/schema.js";
import { SCHEMA_VERSION } from "../src/contract/schema.js";
import { freezeContract } from "../src/contract/freeze.js";
import type { Evidence, ObservedValue } from "../src/evidence/envelope.js";
import type { RunResult, Runner, RunOptions } from "../src/evidence/runner.js";

export function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "C1#0",
    kind: "mechanical",
    collector: "test",
    config: { command: ["npx", "vitest", "run", "--reporter=json"] },
    expect: [{ metric: "failed", op: "equals", value: 0 } satisfies Expectation],
    ...overrides,
  };
}

export function criterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: "C1",
    statement: "The suite passes.",
    binding: true,
    failure_condition: "Any test fails.",
    evidence_requirements: [requirement()],
    ...overrides,
  };
}

export function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    schema_version: SCHEMA_VERSION,
    contract_id: "00000000-0000-4000-8000-000000000000",
    objective: "Keep the suite green.",
    provenance: "pre_registered",
    repo: { remote: "", base_commit: "a".repeat(40) },
    created_at: "2026-08-01T00:00:00.000Z",
    compiler: { name: "test", version: "0.0.0", mode: "manual" },
    criteria: [criterion()],
    supersedes: null,
    amendment: null,
    ...overrides,
  };
}

export function frozen(overrides: Partial<Contract> = {}): FrozenContract {
  return freezeContract(contract(overrides));
}

let evidenceCounter = 0;

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  evidenceCounter += 1;
  return {
    evidence_id: `ev-${String(evidenceCounter).padStart(4, "0")}`,
    contract_hash: "deadbeef",
    criterion_id: "C1",
    requirement_id: "C1#0",
    kind: "mechanical",
    collector: { name: "test", version: "1.0.0", adapter_version: "0.1.0" },
    status: "collected",
    observation: { failed: 0 },
    detail: [],
    provenance: {
      command: ["npm", "test"],
      exit_code: 0,
      head_commit: "b".repeat(40),
      base_commit: "a".repeat(40),
      started_at: "2026-08-02T00:00:00.000Z",
      ended_at: "2026-08-02T00:01:00.000Z",
      env_digest: "sha256:test",
      seed: null,
      produced_by: "genesis",
    },
    artifact_digest: null,
    ...overrides,
  };
}

export function observation(values: Record<string, ObservedValue>): Record<string, ObservedValue> {
  return values;
}

/** Pre-registration facts asserting the contract genuinely came first. */
export const CLEAN_PRE_REGISTRATION: PreRegistrationFacts = {
  determined: true,
  base_is_ancestor: true,
  frozen_before_first_commit: true,
  amended_after_first_commit: false,
};

/** A Runner that replays canned results instead of spawning processes. */
export class FakeRunner implements Runner {
  readonly calls: Array<{ command: readonly string[]; options: RunOptions }> = [];
  readonly #responses: Map<string, Partial<RunResult>>;
  readonly #fallback: Partial<RunResult>;

  constructor(responses: Record<string, Partial<RunResult>> = {}, fallback: Partial<RunResult> = {}) {
    this.#responses = new Map(Object.entries(responses));
    this.#fallback = fallback;
  }

  run(command: readonly string[], options: RunOptions): Promise<RunResult> {
    this.calls.push({ command, options });
    const key = command.join(" ");
    const canned = this.#responses.get(key) ?? this.#fallback;
    return Promise.resolve({
      command,
      exit_code: 0,
      stdout: "",
      stderr: "",
      started_at: "2026-08-02T00:00:00.000Z",
      ended_at: "2026-08-02T00:00:01.000Z",
      timed_out: false,
      spawn_error: null,
      ...canned,
    });
  }
}

/** A Jest-compatible JSON report body. */
export function testReport(params: {
  passed?: number;
  failed?: number;
  skipped?: number;
  tests?: Array<{ file: string; name: string; status: string }>;
}): string {
  const tests = params.tests ?? [];
  const byFile = new Map<string, Array<{ fullName: string; title: string; status: string }>>();

  for (const t of tests) {
    const list = byFile.get(t.file) ?? [];
    list.push({ fullName: t.name, title: t.name, status: t.status });
    byFile.set(t.file, list);
  }

  return JSON.stringify({
    numTotalTests: (params.passed ?? 0) + (params.failed ?? 0) + (params.skipped ?? 0),
    numPassedTests: params.passed ?? 0,
    numFailedTests: params.failed ?? 0,
    numPendingTests: params.skipped ?? 0,
    testResults: [...byFile.entries()].map(([name, assertionResults]) => ({ name, assertionResults })),
  });
}
