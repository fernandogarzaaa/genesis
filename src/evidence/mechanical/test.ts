/**
 * Test collector — Jest-compatible JSON reporters (vitest, jest).
 *
 * Runs each distinct declared command once and answers every requirement that
 * targeted it, so a contract with twelve criteria does not run the suite twelve
 * times.
 *
 * Carries the first mitigation for the contract-gaming risk (docs/v2/04-RISKS.md
 * R1): when a requirement names a specific test and that test's file was
 * introduced or modified in the diff under evaluation, the envelope reports
 * `evidence_authored_in_diff: true`. The Adjudicator refuses to let
 * self-authored proof satisfy a criterion. It does not stop a determined agent
 * — nothing does — but it closes the naive case, and every occurrence lands in
 * the ledger where detection of gaming becomes its own calibration target.
 *
 *   config: { command: string[], selector?: "path/to/file.ts::test name",
 *             timeout_ms?: number }
 *   observes: total, passed, failed, skipped, exit_code
 *             + status, evidence_authored_in_diff  (when selector is set)
 */

import { relative, resolve } from "node:path";
import type { Evidence, ObservedValue } from "../envelope.js";
import { changedFiles } from "../git.js";
import {
  buildEvidence,
  configCommand,
  configNumber,
  configString,
  errorEvidence,
  type Collector,
  type CollectionTarget,
  type CollectorContext,
} from "../registry.js";
import type { RunResult } from "../runner.js";
import { artifactText, tailLines } from "./command.js";

export const ADAPTER_VERSION = "0.1.0";

interface AssertionResult {
  fullName?: string;
  title?: string;
  status?: string;
}

interface FileResult {
  name?: string;
  assertionResults?: AssertionResult[];
}

interface TestReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: FileResult[];
}

export const testCollector: Collector = {
  name: "test",
  adapterVersion: ADAPTER_VERSION,

  async version(): Promise<string> {
    return "jest-json-compatible";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const out: Evidence[] = [];

    // Group by command so each distinct suite runs exactly once.
    const groups = new Map<string, CollectionTarget[]>();
    const unrunnable: CollectionTarget[] = [];

    for (const target of targets) {
      const command = configCommand(target.requirement);
      if (!command) {
        unrunnable.push(target);
        continue;
      }
      const key = JSON.stringify(command);
      const list = groups.get(key);
      if (list) list.push(target);
      else groups.set(key, [target]);
    }

    for (const target of unrunnable) {
      out.push(
        errorEvidence(target, ctx, "test", 'config.command must be an array of strings, e.g. ["npx","vitest","run","--reporter=json"]'),
      );
    }

    for (const [key, groupTargets] of groups) {
      const command = JSON.parse(key) as string[];
      const timeoutMs = groupTargets
        .map((t) => configNumber(t.requirement, "timeout_ms"))
        .find((v) => v !== undefined);

      const result = await ctx.runner.run(command, { cwd: ctx.repoPath, timeoutMs });
      const artifact = ctx.putArtifact(artifactText(result));
      const report = parseReport(result.stdout) ?? parseReport(result.stderr);

      // Only computed when a selector actually needs it.
      let touched: string[] | null = null;
      const touchedFiles = (): string[] => {
        touched ??= changedFiles(ctx.repoPath, ctx.baseCommit, ctx.headCommit);
        return touched;
      };

      for (const target of groupTargets) {
        out.push(
          buildOne(target, ctx, result, report, artifact, touchedFiles),
        );
      }
    }

    return out;
  },
};

function buildOne(
  target: CollectionTarget,
  ctx: CollectorContext,
  result: RunResult,
  report: TestReport | null,
  artifact: string,
  touchedFiles: () => string[],
): Evidence {
  const common = {
    target, ctx,
    collectorName: "test",
    collectorVersion: "jest-json-compatible",
    adapterVersion: ADAPTER_VERSION,
    provenance: result,
    artifactDigest: artifact,
  } as const;

  if (result.spawn_error || result.timed_out) {
    return buildEvidence({
      ...common,
      status: "error",
      observation: {},
      detail: [
        result.spawn_error
          ? `failed to run ${result.command.join(" ")}: ${result.spawn_error}`
          : `${result.command.join(" ")} exceeded its timeout and was killed`,
      ],
    });
  }

  if (!report) {
    return buildEvidence({
      ...common,
      status: "error",
      observation: {},
      detail: [
        "could not parse a Jest-compatible JSON report from the command output",
        "expected something like: npx vitest run --reporter=json",
        ...tailLines(result.stdout || result.stderr, 6),
      ],
    });
  }

  const observation: Record<string, ObservedValue> = {
    total: report.numTotalTests ?? 0,
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: report.numPendingTests ?? 0,
    exit_code: result.exit_code,
  };

  const selector = configString(target.requirement, "selector");
  const detail: string[] = [];

  if (selector !== undefined) {
    const found = findTest(report, selector);
    observation["status"] = found?.status ?? "missing";

    if (found === null) {
      detail.push(`no test matched selector "${selector}"`);
    } else {
      detail.push(`${selector} → ${found.status}`);
      if (found.file) {
        const rel = toRepoRelative(ctx.repoPath, found.file);
        const authored = touchedFiles().includes(rel);
        observation["evidence_authored_in_diff"] = authored;
        if (authored) {
          detail.push(
            `${rel} was introduced or modified in this diff — self-authored proof cannot satisfy a criterion`,
          );
        }
      }
    }
  }

  if (observation["failed"] !== 0) {
    detail.push(...failedNames(report).slice(0, 8).map((n) => `failed: ${n}`));
  }

  return buildEvidence({ ...common, status: "collected", observation, detail });
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseReport(text: string): TestReport | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const direct = tryParse(trimmed);
  if (direct) return direct;

  // Reporters frequently print progress around the JSON payload.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1));

  return null;
}

function tryParse(text: string): TestReport | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "numTotalTests" in parsed) {
      return parsed as TestReport;
    }
  } catch {
    // Not JSON; caller falls through to the brace-slice attempt.
  }
  return null;
}

/**
 * Resolve `path/to/file.ts::test name`, or a bare test name.
 * Matching is exact on the name, then suffix-based on the file path.
 */
export function findTest(
  report: TestReport,
  selector: string,
): { status: string; file: string | null } | null {
  const [rawFile, rawName] = splitSelector(selector);

  for (const file of report.testResults ?? []) {
    if (rawFile && !(file.name ?? "").replaceAll("\\", "/").endsWith(rawFile)) continue;

    for (const assertion of file.assertionResults ?? []) {
      const full = assertion.fullName ?? assertion.title ?? "";
      const title = assertion.title ?? "";
      if (full === rawName || title === rawName || full.endsWith(` ${rawName}`)) {
        return { status: normalizeStatus(assertion.status), file: file.name ?? null };
      }
    }
  }

  return null;
}

function splitSelector(selector: string): [string | null, string] {
  const idx = selector.indexOf("::");
  if (idx < 0) return [null, selector.trim()];
  return [selector.slice(0, idx).trim().replaceAll("\\", "/"), selector.slice(idx + 2).trim()];
}

function normalizeStatus(status: string | undefined): string {
  switch (status) {
    case "passed": return "pass";
    case "failed": return "fail";
    case "pending":
    case "skipped":
    case "todo": return "skip";
    default: return status ?? "unknown";
  }
}

function failedNames(report: TestReport): string[] {
  const names: string[] = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") {
        names.push(assertion.fullName ?? assertion.title ?? "(unnamed)");
      }
    }
  }
  return names;
}

function toRepoRelative(repoPath: string, file: string): string {
  const rel = relative(resolve(repoPath), resolve(file));
  return rel.replaceAll("\\", "/");
}
