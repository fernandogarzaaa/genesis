/**
 * Lint collector — ESLint / Biome JSON output, with an exit-code fallback.
 *
 *   config: { command: string[], format?: "eslint-json" | "biome-json" | "exit-code" }
 *   observes: errors, warnings, exit_code
 */

import type { Evidence } from "../envelope.js";
import {
  configCommand,
  configNumber,
  configString,
  errorEvidence,
  type Collector,
  type CollectionTarget,
  type CollectorContext,
} from "../registry.js";
import { evidenceFromRun } from "./command.js";

export const ADAPTER_VERSION = "0.1.0";

export const lintCollector: Collector = {
  name: "lint",
  adapterVersion: ADAPTER_VERSION,

  async version(): Promise<string> {
    return "n/a";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const out: Evidence[] = [];

    for (const target of targets) {
      const command = configCommand(target.requirement);
      if (!command) {
        out.push(errorEvidence(target, ctx, "lint", 'config.command must be an array of strings'));
        continue;
      }

      const result = await ctx.runner.run(command, {
        cwd: ctx.repoPath,
        timeoutMs: configNumber(target.requirement, "timeout_ms"),
      });

      const format = configString(target.requirement, "format") ?? "exit-code";
      const counts = countDiagnostics(format, result.stdout) ?? {
        // Fallback: a non-zero exit means at least one error, and we say
        // "at least" rather than inventing a precise number.
        errors: result.exit_code === 0 ? 0 : 1,
        warnings: 0,
      };

      out.push(
        evidenceFromRun(target, ctx, "lint", format, result, ADAPTER_VERSION, counts),
      );
    }

    return out;
  },
};

export function countDiagnostics(
  format: string,
  stdout: string,
): { errors: number; warnings: number } | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;

  if (format === "eslint-json") {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ errorCount?: number; warningCount?: number }>;
      if (!Array.isArray(parsed)) return null;
      return {
        errors: parsed.reduce((n, f) => n + (f.errorCount ?? 0), 0),
        warnings: parsed.reduce((n, f) => n + (f.warningCount ?? 0), 0),
      };
    } catch {
      return null;
    }
  }

  if (format === "biome-json") {
    try {
      const parsed = JSON.parse(trimmed) as {
        summary?: { errors?: number; warnings?: number };
        diagnostics?: Array<{ severity?: string }>;
      };
      if (parsed.summary) {
        return { errors: parsed.summary.errors ?? 0, warnings: parsed.summary.warnings ?? 0 };
      }
      const diagnostics = parsed.diagnostics ?? [];
      return {
        errors: diagnostics.filter((d) => d.severity === "error").length,
        warnings: diagnostics.filter((d) => d.severity === "warning").length,
      };
    } catch {
      return null;
    }
  }

  return null;
}
