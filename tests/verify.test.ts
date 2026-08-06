/**
 * End-to-end: a real git repository, a real contract, a real ledger.
 * Only the subprocess runner is faked, so collector commands stay hermetic.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { freezeContract } from "../src/contract/freeze.js";
import { defaultRegistry } from "../src/evidence/collectors.js";
import { CollectorRegistry } from "../src/evidence/registry.js";
import { Ledger } from "../src/ledger/ledger.js";
import { verify, VerifyError, EXIT_CODES, exitCodeFor } from "../src/verify.js";
import { renderVerdict } from "../src/report.js";
import { canonicalize } from "../src/shared/canonical.js";
import { contract, criterion, FakeRunner, requirement, testReport } from "./helpers.js";

let repo: string;
let baseCommit: string;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "genesis-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  baseCommit = git(["rev-parse", "HEAD"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makeContract(overrides = {}) {
  return freezeContract(
    contract({
      repo: { remote: "", base_commit: baseCommit },
      // Frozen before any implementation commit exists.
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
      ...overrides,
    }),
  );
}

function addCommit(message: string): string {
  writeFileSync(join(repo, `${message}.txt`), message);
  git(["add", "."]);
  git(["commit", "-q", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}

describe("verify — pre-registration is a precondition, not a preference", () => {
  it("refuses to grade a contract that was never frozen into the ledger", async () => {
    const ledger = new Ledger(":memory:");
    await expect(
      verify({
        repoPath: repo,
        contract: makeContract(),
        ledger,
        registry: defaultRegistry(),
        runner: new FakeRunner(),
      }),
    ).rejects.toThrow(VerifyError);
    ledger.close();
  });

  it("refuses to grade a contract whose contents no longer match its hash", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);

    await expect(
      verify({
        repoPath: repo,
        contract: { ...frozen, objective: "quietly changed" },
        ledger,
        registry: defaultRegistry(),
        runner: new FakeRunner(),
      }),
    ).rejects.toThrow(/modified after freezing/);
    ledger.close();
  });
});

describe("verify — end to end", () => {
  it("ships when the evidence satisfies the contract", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract({
      criteria: [
        criterion({
          evidence_requirements: [
            requirement({ config: { command: ["npx", "vitest", "run", "--reporter=json"] } }),
          ],
        }),
      ],
    });
    ledger.registerContract(frozen);
    addCommit("feature");

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 3, failed: 0 }) }),
      idSeed: "ev",
    });

    expect(result.adjudication.verdict).toBe("SHIP");
    expect(exitCodeFor(result.adjudication.verdict)).toBe(EXIT_CODES.SHIP);
    ledger.close();
  });

  it("reports NOT READY with a citable artifact when evidence fails", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract({
      criteria: [
        criterion({
          id: "AUTH-001",
          statement: "The authentication endpoint rejects invalid credentials.",
          evidence_requirements: [
            requirement({ id: "AUTH-001#0", config: { command: ["npx", "vitest", "run", "--reporter=json"] } }),
          ],
        }),
      ],
    });
    ledger.registerContract(frozen);
    addCommit("feature");

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 2, failed: 1 }), exit_code: 1 }),
      idSeed: "ev",
    });

    expect(result.adjudication.verdict).toBe("NOT_READY");
    expect(exitCodeFor(result.adjudication.verdict)).toBe(EXIT_CODES.NOT_READY);

    const finding = result.adjudication.criteria[0]?.requirements[0];
    expect(finding?.state).toBe("violated");
    expect(finding?.artifact_digest).toBeTruthy();
    // The artifact the verdict cites must actually be retrievable.
    expect(ledger.getArtifact(finding?.artifact_digest ?? "")).toContain("vitest");
    ledger.close();
  });

  it("escalates to HUMAN REVIEW when the collector could not run", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);
    addCommit("feature");

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: new CollectorRegistry(),
      runner: new FakeRunner(),
    });

    expect(result.adjudication.verdict).toBe("HUMAN_REVIEW");
    expect(exitCodeFor(result.adjudication.verdict)).toBe(EXIT_CODES.HUMAN_REVIEW);
    ledger.close();
  });

  it("escalates when the contract was frozen after work began", async () => {
    const ledger = new Ledger(":memory:");
    addCommit("work-first");
    // Frozen now, i.e. after the commit above.
    const frozen = makeContract({ created_at: new Date(Date.now() + 60_000).toISOString() });
    ledger.registerContract(frozen);

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 3, failed: 0 }) }),
    });

    expect(result.adjudication.verdict).toBe("HUMAN_REVIEW");
    expect(result.adjudication.rationale.join(" ")).toContain("after implementation began");
    ledger.close();
  });
});

describe("verify — the ledger records everything", () => {
  it("appends contract, evidence, and verdict, and the chain stays intact", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);
    addCommit("feature");

    await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 1 }) }),
    });

    expect(ledger.entries({ type: "CONTRACT_REGISTERED" })).toHaveLength(1);
    expect(ledger.entries({ type: "EVIDENCE_RECORDED" }).length).toBeGreaterThan(0);
    expect(ledger.entries({ type: "VERDICT_RENDERED" })).toHaveLength(1);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  });

  it("records inadmissible evidence too — the attempt is data", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);

    const registry = new CollectorRegistry().register({
      name: "test",
      adapterVersion: "0.0.0",
      version: () => Promise.resolve("x"),
      collect: (targets, ctx) =>
        Promise.resolve(
          targets.map((t) => ({
            evidence_id: ctx.nextId(),
            contract_hash: ctx.contractHash,
            criterion_id: t.criterion.id,
            requirement_id: t.requirement.id,
            kind: "mechanical" as const,
            collector: { name: "test", version: "1", adapter_version: "0" },
            status: "collected" as const,
            observation: { failed: 0 },
            detail: [],
            provenance: {
              command: [], exit_code: 0,
              head_commit: ctx.headCommit, base_commit: ctx.baseCommit,
              started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z",
              env_digest: ctx.envDigest, seed: null,
              produced_by: "executor" as const,
            },
            artifact_digest: null,
          })),
        ),
    });

    const result = await verify({ repoPath: repo, contract: frozen, ledger, registry, runner: new FakeRunner() });

    expect(result.rejected).toHaveLength(1);
    expect(ledger.entries({ type: "EVIDENCE_RECORDED" })).toHaveLength(1);
    // Recorded, but it could not satisfy anything.
    expect(result.adjudication.verdict).toBe("HUMAN_REVIEW");
    ledger.close();
  });

  it("makes the verdict replayable from the ledger to a byte-identical result", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);
    addCommit("feature");

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 1 }) }),
      idSeed: "ev",
    });

    const stored = ledger.entries({ type: "VERDICT_RENDERED" })[0]?.payload as {
      verdict: string;
      criteria: unknown;
    };

    expect(stored.verdict).toBe(result.adjudication.verdict);
    // Compared canonically: the ledger stores canonical JSON (sorted keys), so
    // a raw string comparison would differ on key order alone.
    expect(canonicalize(stored.criteria)).toBe(canonicalize(result.adjudication.criteria));
    ledger.close();
  });
});

describe("report rendering", () => {
  it("cites artifacts and labels remediation as advisory", async () => {
    const ledger = new Ledger(":memory:");
    const frozen = makeContract();
    ledger.registerContract(frozen);
    addCommit("feature");

    const result = await verify({
      repoPath: repo,
      contract: frozen,
      ledger,
      registry: defaultRegistry(),
      runner: new FakeRunner({}, { stdout: testReport({ passed: 1, failed: 2 }), exit_code: 1 }),
    });

    const text = renderVerdict(frozen, result);
    expect(text).toContain("VERDICT: NOT READY");
    expect(text).toContain("artifact ");
    expect(text).toContain("advisory — does not affect the verdict");
    expect(text).toContain(frozen.contract_hash.slice(0, 12));
    ledger.close();
  });
});
