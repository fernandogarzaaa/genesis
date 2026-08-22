/**
 * The CLI surface — argument parsing, exit codes, and clean-error behavior on
 * malformed input. `src/cli/main.ts` is otherwise untested: everything below
 * it (validation, adjudication, backtest metrics) has its own test file, but
 * nothing previously exercised the wiring a user actually invokes.
 *
 * Real git repos, a real (file-backed) ledger, and real subprocesses via the
 * default `SubprocessRunner` — `main()` never accepts a fake runner, so a
 * hermetic double would test something other than what ships.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/main.js";
import { EXIT_CODES } from "../src/verify.js";
import { contract, criterion, evidence, requirement } from "./helpers.js";

let dir: string;
let repo: string;
let baseCommit: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Captures stdout/stderr written during one `main()` call. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "genesis-cli-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);
  baseCommit = git(["rev-parse", "HEAD"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const contractPath = () => join(dir, "contract.json");
const ledgerPath = () => join(dir, "ledger.db");

/** A minimal contract whose single requirement is trivially satisfiable. */
function writeMinimalContract(): void {
  const draft = contract({
    repo: { remote: "", base_commit: baseCommit },
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    criteria: [
      criterion({
        evidence_requirements: [
          requirement({
            id: "C1#0",
            kind: "mechanical",
            collector: "command",
            config: { command: ["node", "-e", "process.exit(0)"] },
            expect: [{ metric: "exit_code", op: "equals", value: 0 }],
          }),
        ],
      }),
    ],
  });
  writeFileSync(contractPath(), `${JSON.stringify(draft, null, 2)}\n`);
}

describe("genesis contract validate", () => {
  it("succeeds on a valid minimal contract", async () => {
    writeMinimalContract();
    const cap = capture();
    const code = await main(["contract", "validate", "--contract", contractPath()]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("Valid.");
  });

  it("fails cleanly, not with a raw exception, on a malformed contract", async () => {
    writeFileSync(contractPath(), JSON.stringify({ not: "a contract" }));
    const cap = capture();
    const code = await main(["contract", "validate", "--contract", contractPath()]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("error");
    expect(cap.stderr()).not.toContain("at Object");
  });
});

describe("genesis contract freeze / amend", () => {
  it("freezes then amends a valid contract", async () => {
    writeMinimalContract();

    let cap = capture();
    let code = await main(["contract", "freeze", "--contract", contractPath(), "--ledger", ledgerPath()]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("Frozen.");

    cap = capture();
    code = await main([
      "contract", "amend",
      "--contract", contractPath(),
      "--reason", "tightening a threshold",
      "--author", "tester",
      "--ledger", ledgerPath(),
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("Amended.");
  });

  it("refuses to amend a contract that was never frozen", async () => {
    writeMinimalContract();
    const cap = capture();
    const code = await main([
      "contract", "amend",
      "--contract", contractPath(),
      "--reason", "x",
      "--author", "tester",
      "--ledger", ledgerPath(),
    ]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("has not been frozen");
  });
});

describe("genesis verify", () => {
  async function freeze(): Promise<void> {
    writeMinimalContract();
    const cap = capture();
    const code = await main(["contract", "freeze", "--contract", contractPath(), "--ledger", ledgerPath()]);
    cap.restore();
    expect(code).toBe(0);
  }

  it("ships a frozen contract whose evidence satisfies every criterion", async () => {
    await freeze();
    const cap = capture();
    const code = await main([
      "verify", "--contract", contractPath(), "--repo", repo, "--ledger", ledgerPath(), "--json",
    ]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.SHIP);
    expect(JSON.parse(cap.stdout()).verdict).toBe("SHIP");
  });

  it("fails cleanly, not with a raw exception, when --contract fails validation", async () => {
    await freeze();
    // Corrupt the frozen contract in a way validateContract will catch:
    // strip every criterion.
    const raw = JSON.parse(readFileSync(contractPath(), "utf8"));
    raw.criteria = [];
    writeFileSync(contractPath(), JSON.stringify(raw));

    const cap = capture();
    const code = await main([
      "verify", "--contract", contractPath(), "--repo", repo, "--ledger", ledgerPath(),
    ]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("Refusing to verify an invalid contract");
    expect(cap.stderr()).not.toContain("at Object");
  });
});

describe("genesis backtest", () => {
  it("succeeds on a dataset of valid rows", async () => {
    writeMinimalContract();
    const freezeCap = capture();
    await main(["contract", "freeze", "--contract", contractPath(), "--ledger", ledgerPath()]);
    freezeCap.restore();
    const frozen = JSON.parse(readFileSync(contractPath(), "utf8"));

    const row = {
      id: "case-1",
      contract: frozen,
      evidence: [evidence({ contract_hash: frozen.contract_hash, observation: { exit_code: 0 } })],
      outcome: "merged_clean",
    };
    const datasetPath = join(dir, "dataset.jsonl");
    writeFileSync(datasetPath, `${JSON.stringify(row)}\n`);

    const cap = capture();
    const code = await main(["backtest", "--dataset", datasetPath, "--json"]);
    cap.restore();
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout()).cases).toHaveLength(1);
  });

  it("fails cleanly, reporting the row and the problem, on a malformed dataset row", async () => {
    const datasetPath = join(dir, "dataset.jsonl");
    writeFileSync(
      datasetPath,
      `${JSON.stringify({ id: "bad-1", contract: { not: "a contract" }, evidence: "not-an-array", outcome: "not-a-real-outcome" })}\n`,
    );

    const cap = capture();
    const code = await main(["backtest", "--dataset", datasetPath]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("row 0");
    expect(cap.stderr()).toContain('"evidence" must be an array');
    expect(cap.stderr()).toContain("outcome");
  });
});

describe("genesis audit", () => {
  it("runs a probe suite against a verifier and exits with a known audit code", async () => {
    const cap = capture();
    const code = await main([
      "audit",
      "--suite", "json",
      "--verifier", "node -e process.exit(0) {task_file} {completion_file}",
      "--accept", "exit_zero",
      "--json",
    ]);
    cap.restore();
    expect([0, 1, 2]).toContain(code);
    expect(() => JSON.parse(cap.stdout())).not.toThrow();
  });

  it("fails cleanly on an unknown suite rather than crashing", async () => {
    const cap = capture();
    const code = await main(["audit", "--suite", "nope", "--verifier", "x {task_file} {completion_file}"]);
    cap.restore();
    expect(code).toBe(EXIT_CODES.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("unknown suite");
  });
});

describe("genesis suites", () => {
  it("lists the registered probe suites and their defect classes", async () => {
    const cap = capture();
    const code = await main(["suites"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("json@");
    expect(cap.stdout()).toContain("code@");
  });
});
