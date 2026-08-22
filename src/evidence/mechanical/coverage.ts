/**
 * Coverage collector — istanbul `json-summary` format (c8, nyc, vitest, jest).
 *
 * Delta is measured against a summary produced from the base commit, supplied
 * by the caller rather than recomputed here. Genesis does not check out and
 * build the base tree: that would double every verify run's cost and require a
 * second working copy. Where no base summary is available, the delta metric is
 * simply absent — and an expectation on it becomes undecidable, which yields
 * HUMAN REVIEW rather than a fabricated zero.
 *
 *   config: { command?: string[], summary_path: string, base_summary_path?: string }
 *   observes: lines_pct, statements_pct, functions_pct, branches_pct,
 *             lines_pct_delta (only when a base summary is given)
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Evidence, ObservedValue } from "../envelope.js";
import {
  buildEvidence,
  configCommand,
  configNumber,
  configString,
  type Collector,
  type CollectionTarget,
  type CollectorContext,
} from "../registry.js";
import { artifactText } from "./command.js";
import type { RunResult } from "../runner.js";

export const ADAPTER_VERSION = "0.1.0";

interface Summary {
  total?: {
    lines?: { pct?: number };
    statements?: { pct?: number };
    functions?: { pct?: number };
    branches?: { pct?: number };
  };
}

export const coverageCollector: Collector = {
  name: "coverage",
  adapterVersion: ADAPTER_VERSION,

  async version(): Promise<string> {
    return "istanbul-json-summary";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const out: Evidence[] = [];

    for (const target of targets) {
      const now = new Date().toISOString();
      const command = configCommand(target.requirement);
      let result: RunResult | null = null;

      if (command) {
        result = await ctx.runner.run(command, {
          cwd: ctx.repoPath,
          timeoutMs: configNumber(target.requirement, "timeout_ms"),
        });
      }

      const summaryPath = configString(target.requirement, "summary_path");
      const common = {
        target, ctx,
        collectorName: "coverage",
        collectorVersion: "istanbul-json-summary",
        adapterVersion: ADAPTER_VERSION,
        provenance: result ?? {
          command: [] as string[], exit_code: null, started_at: now, ended_at: now,
        },
        artifactDigest: result ? ctx.putArtifact(artifactText(result)) : null,
      } as const;

      if (!summaryPath) {
        out.push(buildEvidence({
          ...common,
          status: "error",
          observation: {},
          detail: ['config.summary_path is required, e.g. "coverage/coverage-summary.json"'],
        }));
        continue;
      }

      const head = readSummary(ctx.repoPath, summaryPath);
      if (!head) {
        out.push(buildEvidence({
          ...common,
          status: "error",
          observation: {},
          detail: [`could not read a coverage summary at ${summaryPath}`],
        }));
        continue;
      }

      const observation: Record<string, ObservedValue> = {
        lines_pct: pct(head, "lines"),
        statements_pct: pct(head, "statements"),
        functions_pct: pct(head, "functions"),
        branches_pct: pct(head, "branches"),
      };

      const detail = [`lines ${observation.lines_pct}%`];

      const basePath = configString(target.requirement, "base_summary_path");
      if (basePath) {
        const base = readSummary(ctx.repoPath, basePath);
        if (base) {
          const delta = round(pct(head, "lines") - pct(base, "lines"));
          observation.lines_pct_delta = delta;
          detail.push(`${pct(base, "lines")}% → ${pct(head, "lines")}% (delta ${delta >= 0 ? "+" : ""}${delta}pp)`);
        } else {
          detail.push(`no base summary at ${basePath}; delta metrics are unavailable`);
        }
      }

      out.push(buildEvidence({ ...common, status: "collected", observation, detail }));
    }

    return out;
  },
};

function readSummary(repoPath: string, path: string): Summary | null {
  try {
    const full = isAbsolute(path) ? path : join(repoPath, path);
    return JSON.parse(readFileSync(full, "utf8")) as Summary;
  } catch {
    return null;
  }
}

function pct(summary: Summary, key: "lines" | "statements" | "functions" | "branches"): number {
  return round(summary.total?.[key]?.pct ?? 0);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
