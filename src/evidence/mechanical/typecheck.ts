/**
 * Typecheck collector — counts compiler diagnostics.
 *
 *   config: { command: string[], timeout_ms?: number }
 *   observes: errors, exit_code, timed_out, ...
 */

import type { Evidence } from "../envelope.js";
import {
  configCommand,
  configNumber,
  errorEvidence,
  type Collector,
  type CollectionTarget,
  type CollectorContext,
} from "../registry.js";
import { evidenceFromRun } from "./command.js";

export const ADAPTER_VERSION = "0.1.0";

/** `path/file.ts(12,5): error TS2307: ...` and `error TS2307: ...` */
const TS_ERROR = /(?:^|\n)[^\n]*?error TS\d+:/g;

export const typecheckCollector: Collector = {
  name: "typecheck",
  adapterVersion: ADAPTER_VERSION,

  async version(ctx: CollectorContext): Promise<string> {
    const result = await ctx.runner.run(["npx", "tsc", "--version"], {
      cwd: ctx.repoPath,
      timeoutMs: 60_000,
    });
    return result.stdout.trim() || "unknown";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const version = await this.version(ctx);
    const out: Evidence[] = [];

    for (const target of targets) {
      const command = configCommand(target.requirement);
      if (!command) {
        out.push(errorEvidence(target, ctx, "typecheck", 'config.command must be an array of strings, e.g. ["npx","tsc","--noEmit"]'));
        continue;
      }

      const result = await ctx.runner.run(command, {
        cwd: ctx.repoPath,
        timeoutMs: configNumber(target.requirement, "timeout_ms"),
      });

      const combined = `${result.stdout}\n${result.stderr}`;
      TS_ERROR.lastIndex = 0;
      const errors = (combined.match(TS_ERROR) ?? []).length;

      out.push(
        evidenceFromRun(target, ctx, "typecheck", version, result, ADAPTER_VERSION, { errors }),
      );
    }

    return out;
  },
};
