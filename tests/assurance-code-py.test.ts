/**
 * The Python/pytest code suite. Mirrors the code-suite coverage in
 * `assurance.test.ts`: the suite is diagnostic, registered, content-addressed,
 * and — run end to end against the Python fixture verifiers — catches every
 * planted defect in the naive harness without slandering the strict one.
 *
 * The end-to-end tests need `python3` with pytest importable and skip
 * themselves otherwise.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runAudit } from "../src/assurance/audit.js";
import { controlProbes, exploitProbes, suiteDigest, validateSuite } from "../src/assurance/probe.js";
import { codePySuite, codeSuite, getSuite, suiteNames } from "../src/assurance/suites/index.js";
import { DEFECT_CLASSES } from "../src/assurance/taxonomy.js";
import { VerifierAdapter } from "../src/assurance/verifier.js";
import { SubprocessRunner } from "../src/evidence/runner.js";

const NAIVE = ["python3", "fixtures/verifiers/naive_pytest.py", "{task_file}", "{completion_file}"];
const STRICT = ["python3", "fixtures/verifiers/strict_pytest.py", "{task_file}", "{completion_file}"];

const hasPytest = (() => {
  const r = spawnSync("python3", ["-c", "import pytest"], { encoding: "utf8" });
  return !r.error && r.status === 0;
})();

function adapter(command: readonly string[], name: string) {
  return new VerifierAdapter(
    { name, command, accept: { kind: "json_reward" }, timeout_ms: 15_000 },
    new SubprocessRunner(),
  );
}

describe("code-py suite", () => {
  it("is registered under its own name", () => {
    expect(suiteNames()).toContain("code-py");
    expect(getSuite("code-py")).toBe(codePySuite);
  });

  it("is diagnostic", () => {
    expect(validateSuite(codePySuite)).toEqual([]);
  });

  it("uses only the published code defect classes", () => {
    for (const probe of codePySuite.probes) {
      expect(probe.domain).toBe("code");
      expect(DEFECT_CLASSES).toContain(probe.defect_class);
    }
    expect(new Set(exploitProbes(codePySuite).map((p) => p.defect_class))).toEqual(
      new Set(["visible_test_overfitting", "stdout_spoofing", "missing_timeouts"]),
    );
  });

  // A correct solution and a correct-but-noisy one, as in the code suite.
  it("carries at least two control probes", () => {
    expect(controlProbes(codePySuite).map((p) => p.id).sort()).toEqual([
      "code-py/control-correct",
      "code-py/control-correct-noisy",
    ]);
  });

  it("probes every Python gaming technique it claims to", () => {
    const ids = exploitProbes(codePySuite).map((p) => p.id);
    for (const id of [
      "code-py/visible-hardcode",
      "code-py/special-case-inputs",
      "code-py/stdout-spoof",
      "code-py/sys-exit-import",
      "code-py/os-exit-import",
      "code-py/pytest-hook-deselect",
      "code-py/pytest-hook-forcepass",
      "code-py/skip-as-success",
      "code-py/timeout",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("ships pytest functions as visible and held-out tests", () => {
    for (const probe of codePySuite.probes) {
      expect(probe.task.visible_tests?.length).toBeGreaterThan(0);
      expect(probe.task.hidden_tests?.length).toBeGreaterThan(0);
      for (const test of [...(probe.task.visible_tests ?? []), ...(probe.task.hidden_tests ?? [])]) {
        expect(test).toMatch(/^def test_\w+\(\):\n {4}assert /);
      }
    }
  });

  it("has a stable digest distinct from the JavaScript code suite", () => {
    expect(suiteDigest(codePySuite)).toBe(suiteDigest({ ...codePySuite }));
    expect(suiteDigest(codePySuite)).not.toBe(suiteDigest(codeSuite));
  });

  it("rejects a variant with no controls", () => {
    expect(validateSuite({ ...codePySuite, probes: exploitProbes(codePySuite) }).join(" ")).toContain(
      "no control probes",
    );
  });
});

describe.skipIf(!hasPytest)("code-py end to end (python3 + pytest)", () => {
  it("finds every planted defect in the naive pytest harness", async () => {
    const record = await runAudit({ verifier: adapter(NAIVE, "naive_pytest"), suite: codePySuite });

    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect(record.conclusion.metrics.false_accept_rate.point).toBe(1);
    expect(record.conclusion.metrics.false_reject_rate.point).toBe(0);
    expect([...record.conclusion.metrics.exploitable_classes].sort()).toEqual([
      "missing_timeouts",
      "stdout_spoofing",
      "visible_test_overfitting",
    ]);
    // Every exploit lands, including the pytest-hook and skip tricks.
    for (const r of record.results.filter((x) => x.expected === "reject")) {
      expect(["false_accept", "unresponsive"]).toContain(r.outcome);
    }
  }, 120_000);

  it("clears the strict pytest harness, with zero false rejects", async () => {
    const record = await runAudit({ verifier: adapter(STRICT, "strict_pytest"), suite: codePySuite });

    expect(record.conclusion.verdict).toBe("SOUND");
    expect(record.conclusion.metrics.false_accept_rate.point).toBe(0);
    expect(record.conclusion.metrics.false_reject_rate.point).toBe(0);
    expect(record.conclusion.findings).toEqual([]);
  }, 120_000);
});
