import { describe, expect, it } from "vitest";
import { collectEvidence, makeContext } from "../src/evidence/collect.js";
import { defaultRegistry } from "../src/evidence/collectors.js";
import { countDiagnostics } from "../src/evidence/mechanical/lint.js";
import { findTest, parseReport, testCollector } from "../src/evidence/mechanical/test.js";
import { typecheckCollector } from "../src/evidence/mechanical/typecheck.js";
import { commandCollector } from "../src/evidence/mechanical/command.js";
import { eveCollector, parseSession } from "../src/evidence/behavioral/eve.js";
import { CollectorRegistry } from "../src/evidence/registry.js";
import { criterion, contract, FakeRunner, requirement, testReport } from "./helpers.js";
import { freezeContract } from "../src/contract/freeze.js";

function ctx(runner: FakeRunner) {
  return makeContext({
    repoPath: "/nonexistent-repo",
    contractHash: "deadbeef",
    headCommit: "b".repeat(40),
    baseCommit: "a".repeat(40),
    envDigest: "sha256:test",
    runner,
    putArtifact: () => "sha256:artifact",
    idSeed: "ev",
  });
}

function target(req: Partial<Parameters<typeof requirement>[0]> = {}) {
  const r = requirement(req);
  return { criterion: criterion({ evidence_requirements: [r] }), requirement: r };
}

describe("command collector", () => {
  it("observes exit code and output shape", async () => {
    const runner = new FakeRunner({}, { exit_code: 0, stdout: "line one\nline two\n" });
    const [record] = await commandCollector.collect(
      [target({ collector: "command", config: { command: ["echo", "hi"] } })],
      ctx(runner),
    );

    expect(record?.status).toBe("collected");
    expect(record?.observation["exit_code"]).toBe(0);
    expect(record?.observation["stdout_lines"]).toBe(2);
  });

  it("reports an error rather than a result when the command times out", async () => {
    const runner = new FakeRunner({}, { timed_out: true, exit_code: null });
    const [record] = await commandCollector.collect(
      [target({ collector: "command", config: { command: ["sleep", "999"] } })],
      ctx(runner),
    );
    expect(record?.status).toBe("error");
  });

  it("errors when no command is configured", async () => {
    const [record] = await commandCollector.collect(
      [target({ collector: "command", config: {} })],
      ctx(new FakeRunner()),
    );
    expect(record?.status).toBe("error");
    expect(record?.detail[0]).toContain("config.command");
  });

  it("evaluates a configured regex against the output", async () => {
    const runner = new FakeRunner({}, { stdout: "Build succeeded in 4s" });
    const [record] = await commandCollector.collect(
      [target({ collector: "command", config: { command: ["build"], match: "succeeded" } })],
      ctx(runner),
    );
    expect(record?.observation["matched"]).toBe(true);
  });
});

describe("test collector", () => {
  const REPORT = testReport({
    passed: 2,
    failed: 1,
    tests: [
      { file: "/repo/tests/auth.spec.ts", name: "rejects invalid credentials", status: "failed" },
      { file: "/repo/tests/auth.spec.ts", name: "accepts valid credentials", status: "passed" },
      { file: "/repo/tests/other.spec.ts", name: "does something", status: "passed" },
    ],
  });

  it("observes the aggregate counts", async () => {
    const runner = new FakeRunner({}, { stdout: REPORT, exit_code: 1 });
    const [record] = await testCollector.collect(
      [target({ config: { command: ["npx", "vitest", "run", "--reporter=json"] } })],
      ctx(runner),
    );

    expect(record?.status).toBe("collected");
    expect(record?.observation).toMatchObject({ total: 3, passed: 2, failed: 1 });
  });

  it("resolves a file::name selector", async () => {
    const runner = new FakeRunner({}, { stdout: REPORT, exit_code: 1 });
    const [record] = await testCollector.collect(
      [
        target({
          config: {
            command: ["npx", "vitest", "run", "--reporter=json"],
            selector: "tests/auth.spec.ts::rejects invalid credentials",
          },
        }),
      ],
      ctx(runner),
    );

    expect(record?.observation["status"]).toBe("fail");
  });

  it("reports a missing selector as missing rather than passing", async () => {
    const runner = new FakeRunner({}, { stdout: REPORT });
    const [record] = await testCollector.collect(
      [target({ config: { command: ["t"], selector: "tests/auth.spec.ts::a test nobody wrote" } })],
      ctx(runner),
    );
    expect(record?.observation["status"]).toBe("missing");
  });

  // Efficiency property: a contract with many criteria must not run the suite
  // once per criterion.
  it("runs one command once for every requirement that targets it", async () => {
    const runner = new FakeRunner({}, { stdout: REPORT });
    const command = ["npx", "vitest", "run", "--reporter=json"];
    const a = requirement({ id: "C1#0", config: { command } });
    const b = requirement({ id: "C1#1", config: { command } });
    const c = criterion({ evidence_requirements: [a, b] });

    const records = await testCollector.collect(
      [{ criterion: c, requirement: a }, { criterion: c, requirement: b }],
      ctx(runner),
    );

    expect(records).toHaveLength(2);
    expect(runner.calls).toHaveLength(1);
  });

  it("errors when the output is not a parseable report", async () => {
    const runner = new FakeRunner({}, { stdout: "everything is fine, trust me" });
    const [record] = await testCollector.collect([target({ config: { command: ["t"] } })], ctx(runner));
    expect(record?.status).toBe("error");
  });
});

describe("test report parsing", () => {
  it("parses a bare JSON report", () => {
    expect(parseReport(testReport({ passed: 1 }))?.numPassedTests).toBe(1);
  });

  it("parses a report surrounded by reporter noise", () => {
    const noisy = `RUN v4.1.10\n${testReport({ passed: 1 })}\nDone in 2s`;
    expect(parseReport(noisy)?.numPassedTests).toBe(1);
  });

  it("returns null for non-JSON", () => {
    expect(parseReport("no json here")).toBeNull();
  });

  it("matches a selector by path suffix", () => {
    const report = JSON.parse(
      testReport({ tests: [{ file: "/a/b/c/tests/x.spec.ts", name: "works", status: "passed" }] }),
    );
    expect(findTest(report, "tests/x.spec.ts::works")?.status).toBe("pass");
  });

  it("does not match the right name in the wrong file", () => {
    const report = JSON.parse(
      testReport({ tests: [{ file: "/a/tests/x.spec.ts", name: "works", status: "passed" }] }),
    );
    expect(findTest(report, "tests/y.spec.ts::works")).toBeNull();
  });
});

describe("typecheck collector", () => {
  it("counts TypeScript diagnostics", async () => {
    const runner = new FakeRunner(
      { "npx tsc --version": { stdout: "Version 5.9.3" } },
      {
        exit_code: 2,
        stdout: [
          "src/a.ts(1,1): error TS2307: Cannot find module './x.js'.",
          "src/b.ts(4,9): error TS2339: Property 'y' does not exist.",
        ].join("\n"),
      },
    );

    const [record] = await typecheckCollector.collect(
      [target({ collector: "typecheck", config: { command: ["npx", "tsc", "--noEmit"] } })],
      ctx(runner),
    );

    expect(record?.observation["errors"]).toBe(2);
  });

  it("reports zero errors on a clean run", async () => {
    const runner = new FakeRunner({ "npx tsc --version": { stdout: "Version 5.9.3" } }, { exit_code: 0, stdout: "" });
    const [record] = await typecheckCollector.collect(
      [target({ collector: "typecheck", config: { command: ["npx", "tsc", "--noEmit"] } })],
      ctx(runner),
    );
    expect(record?.observation["errors"]).toBe(0);
  });
});

describe("lint diagnostics", () => {
  it("sums ESLint counts across files", () => {
    const stdout = JSON.stringify([
      { errorCount: 2, warningCount: 1 },
      { errorCount: 0, warningCount: 3 },
    ]);
    expect(countDiagnostics("eslint-json", stdout)).toEqual({ errors: 2, warnings: 4 });
  });

  it("reads a Biome summary", () => {
    const stdout = JSON.stringify({ summary: { errors: 3, warnings: 2 } });
    expect(countDiagnostics("biome-json", stdout)).toEqual({ errors: 3, warnings: 2 });
  });

  it("returns null for unparseable output so the caller can fall back", () => {
    expect(countDiagnostics("eslint-json", "not json")).toBeNull();
  });
});

describe("eve collector", () => {
  const SESSION = JSON.stringify({
    seed: 4711,
    goalAchieved: false,
    abandoned: true,
    abandonReason: "frustration exceeded tolerance",
    personaName: "first-time-user",
    startUrl: "http://localhost:3000",
    findings: [
      { severity: "critical", title: "Lockout screen gives no reason" },
      { severity: "major", title: "Slow feedback on submit" },
    ],
    scores: [{ dimension: "overall", value: 41 }],
    usage: { steps: 22, durationMs: 60000 },
  });

  it("maps a SessionResult onto observations", async () => {
    const runner = new FakeRunner({ "npx eve --version": { stdout: "0.3.1" } }, { stdout: SESSION });
    const [record] = await eveCollector.collect(
      [
        target({
          collector: "eve",
          kind: "behavioral",
          config: { url: "http://localhost:3000", seed: 4711, persona: "first-time-user" },
          expect: [{ metric: "critical_findings", op: "lte", value: 0 }],
        }),
      ],
      ctx(runner),
    );

    expect(record?.status).toBe("collected");
    expect(record?.observation).toMatchObject({
      goal_achieved: false,
      abandoned: true,
      critical_findings: 1,
      major_findings: 1,
      overall_score: 41,
    });
  });

  it("records the seed in provenance so the session can be reproduced", async () => {
    const runner = new FakeRunner({ "npx eve --version": { stdout: "0.3.1" } }, { stdout: SESSION });
    const [record] = await eveCollector.collect(
      [target({ collector: "eve", kind: "behavioral", config: { url: "http://x", seed: 4711 } })],
      ctx(runner),
    );
    expect(record?.provenance.seed).toBe(4711);
  });

  it("refuses to run without a seed", async () => {
    const runner = new FakeRunner({ "npx eve --version": { stdout: "0.3.1" } }, { stdout: SESSION });
    const [record] = await eveCollector.collect(
      [target({ collector: "eve", kind: "behavioral", config: { url: "http://x" } })],
      ctx(runner),
    );
    expect(record?.status).toBe("error");
    expect(record?.detail[0]).toContain("seed");
  });

  it("passes the seed through to the CLI invocation", async () => {
    const runner = new FakeRunner({ "npx eve --version": { stdout: "0.3.1" } }, { stdout: SESSION });
    await eveCollector.collect(
      [target({ collector: "eve", kind: "behavioral", config: { url: "http://x", seed: 99 } })],
      ctx(runner),
    );
    const run = runner.calls.find((c) => c.command.includes("run"));
    expect(run?.command).toEqual(expect.arrayContaining(["--seed", "99", "--json"]));
  });

  it("parses a session nested under `result`", () => {
    expect(parseSession(JSON.stringify({ result: { goalAchieved: true } }))?.goalAchieved).toBe(true);
  });
});

describe("collection orchestration", () => {
  it("produces evidence for every requirement even when a collector throws", async () => {
    const registry = new CollectorRegistry().register({
      name: "test",
      adapterVersion: "0.0.0",
      version: () => Promise.resolve("x"),
      collect: () => Promise.reject(new Error("collector exploded")),
    });

    const frozen = freezeContract(contract());
    const records = await collectEvidence(frozen, registry, ctx(new FakeRunner()));

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("error");
    expect(records[0]?.detail[0]).toContain("collector exploded");
  });

  it("fills in evidence for a requirement the collector silently skipped", async () => {
    const registry = new CollectorRegistry().register({
      name: "test",
      adapterVersion: "0.0.0",
      version: () => Promise.resolve("x"),
      collect: () => Promise.resolve([]),
    });

    const frozen = freezeContract(contract());
    const records = await collectEvidence(frozen, registry, ctx(new FakeRunner()));

    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("error");
    expect(records[0]?.detail[0]).toContain("returned no evidence");
  });

  it("errors clearly when the contract names an unregistered collector", async () => {
    const frozen = freezeContract(
      contract({ criteria: [criterion({ evidence_requirements: [requirement({ collector: "nope" })] })] }),
    );
    const records = await collectEvidence(frozen, new CollectorRegistry(), ctx(new FakeRunner()));
    expect(records[0]?.detail[0]).toContain('no collector named "nope"');
  });
});

describe("default registry", () => {
  it("registers the mechanical and behavioral collectors", () => {
    expect(defaultRegistry().names()).toEqual([
      "command", "coverage", "diff", "eve", "lint", "test", "typecheck",
    ]);
  });

  // The judgmental tier is deliberately absent: the lattice already handles it,
  // and shipping the policy before the tier is the cheap moment to do it.
  it("registers no judgmental collector yet", () => {
    expect(defaultRegistry().get("llm-judge")).toBeUndefined();
  });
});
