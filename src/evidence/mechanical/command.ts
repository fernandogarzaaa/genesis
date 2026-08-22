/**
 * Generic command collector.
 *
 * Runs a declared command and observes its exit code and output shape. The
 * escape hatch for tools Genesis has no dedicated adapter for — and the
 * building block the more specific mechanical collectors extend.
 *
 *   config: { command: string[], timeout_ms?: number }
 *   observes: exit_code, timed_out, stdout_lines, stderr_lines,
 *             stdout_bytes, matched (when config.match is a regex source)
 */

import type { Evidence } from "../envelope.js";
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

export const ADAPTER_VERSION = "0.1.0";

export const commandCollector: Collector = {
  name: "command",
  adapterVersion: ADAPTER_VERSION,

  async version(): Promise<string> {
    return "n/a";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const out: Evidence[] = [];

    for (const target of targets) {
      const command = configCommand(target.requirement);
      if (!command) {
        out.push(
          errorEvidence(target, ctx, "command", 'config.command must be an array of strings, e.g. ["npm","test"]'),
        );
        continue;
      }

      const result = await ctx.runner.run(command, {
        cwd: ctx.repoPath,
        timeoutMs: configNumber(target.requirement, "timeout_ms"),
      });

      out.push(evidenceFromRun(target, ctx, "command", "n/a", result, ADAPTER_VERSION));
    }

    return out;
  },
};

/** Shared envelope construction for any collector that just runs a command. */
export function evidenceFromRun(
  target: CollectionTarget,
  ctx: CollectorContext,
  collectorName: string,
  collectorVersion: string,
  result: RunResult,
  adapterVersion: string,
  extraObservation: Record<string, string | number | boolean | null> = {},
): Evidence {
  const artifact = ctx.putArtifact(artifactText(result));

  if (result.spawn_error) {
    return buildEvidence({
      target, ctx, collectorName, collectorVersion, adapterVersion,
      status: "error",
      observation: {},
      detail: [`failed to run ${result.command.join(" ")}: ${result.spawn_error}`],
      provenance: result,
      artifactDigest: artifact,
    });
  }

  if (result.timed_out) {
    return buildEvidence({
      target, ctx, collectorName, collectorVersion, adapterVersion,
      status: "error",
      observation: {},
      detail: [`${result.command.join(" ")} exceeded its timeout and was killed`],
      provenance: result,
      artifactDigest: artifact,
    });
  }

  const match = configString(target.requirement, "match");
  const observation: Record<string, string | number | boolean | null> = {
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stdout_lines: countLines(result.stdout),
    stderr_lines: countLines(result.stderr),
    stdout_bytes: Buffer.byteLength(result.stdout),
    ...extraObservation,
  };

  if (match !== undefined) {
    let matched = false;
    try {
      matched = new RegExp(match).test(result.stdout + result.stderr);
    } catch {
      matched = false;
    }
    observation.matched = matched;
  }

  return buildEvidence({
    target, ctx, collectorName, collectorVersion, adapterVersion,
    status: "collected",
    observation,
    detail: tailLines(result.stdout || result.stderr, 12),
    provenance: result,
    artifactDigest: artifact,
  });
}

export function artifactText(result: RunResult): string {
  return [
    `$ ${result.command.join(" ")}`,
    `exit: ${result.exit_code ?? "null"}  timed_out: ${result.timed_out}`,
    "--- stdout ---",
    result.stdout,
    "--- stderr ---",
    result.stderr,
  ].join("\n");
}

export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

export function tailLines(text: string, n: number): string[] {
  return text.split("\n").filter((l) => l.trim() !== "").slice(-n);
}
