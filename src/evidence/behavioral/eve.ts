/**
 * EVE adapter — behavioral evidence.
 *
 * EVE (the Experience Validation Engine) is consumed across a process boundary
 * and is never modified or absorbed. Two reasons, both structural:
 *
 *  1. Neutrality. Genesis adjudicates evidence it did not author. If EVE lived
 *     inside Genesis, Genesis would be grading its own output — the same
 *     failure the executor/grader separation exists to prevent, one layer down.
 *  2. EVE is a shipping product with its own release cadence. Absorbing it
 *     would trade that for a subdirectory.
 *
 * EVE is one behavioral evidence producer, not *the* behavioral evidence
 * producer. Anything that can emit a seeded, reproducible observation over this
 * same envelope belongs here on equal terms.
 *
 * What makes its output admissible is determinism: "given the same seed,
 * persona and application state, EVE takes the same path." The seed is recorded
 * in provenance, and `admissibility.ts` rejects behavioral evidence that
 * arrives without one.
 *
 *   config: { url, persona?, goal?, seed, command?: string[], timeout_ms? }
 *   observes: goal_achieved, abandoned, overall_score, critical_findings,
 *             major_findings, total_findings, steps, seed
 */

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
import { artifactText } from "../mechanical/command.js";

export const ADAPTER_VERSION = "0.1.0";

/** The subset of EVE's `SessionResult` this adapter depends on. */
interface SessionResult {
  seed?: number;
  goalAchieved?: boolean;
  abandoned?: boolean;
  abandonReason?: string | null;
  endReason?: string;
  personaName?: string;
  startUrl?: string;
  findings?: Array<{ severity?: string; title?: string; category?: string }>;
  scores?: Array<{ dimension?: string; value?: number }>;
  usage?: { steps?: number; durationMs?: number };
}

export const eveCollector: Collector = {
  name: "eve",
  adapterVersion: ADAPTER_VERSION,

  async version(ctx: CollectorContext): Promise<string> {
    const result = await ctx.runner.run(["npx", "eve", "--version"], {
      cwd: ctx.repoPath,
      timeoutMs: 60_000,
    });
    return result.stdout.trim() || "unknown";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const version = await this.version(ctx);
    const out: Evidence[] = [];

    for (const target of targets) {
      const req = target.requirement;
      const seed = configNumber(req, "seed");
      const url = configString(req, "url");
      const now = new Date().toISOString();

      const common = {
        target, ctx,
        collectorName: "eve",
        collectorVersion: version,
        adapterVersion: ADAPTER_VERSION,
      } as const;

      if (seed === undefined || url === undefined) {
        out.push(buildEvidence({
          ...common,
          status: "error",
          observation: {},
          detail: [
            "config.url and config.seed are both required — behavioral evidence without a " +
              "recorded seed is not reproducible, and evidence that cannot be reproduced " +
              "cannot be re-adjudicated when the ledger is replayed",
          ],
          provenance: { command: [], exit_code: null, started_at: now, ended_at: now },
        }));
        continue;
      }

      const command = configCommand(req) ?? defaultCommand(req, url, seed);
      const result = await ctx.runner.run(command, {
        cwd: ctx.repoPath,
        timeoutMs: configNumber(req, "timeout_ms") ?? 15 * 60_000,
      });
      const artifact = ctx.putArtifact(artifactText(result));
      const session = parseSession(result.stdout) ?? parseSession(result.stderr);

      if (result.spawn_error || result.timed_out || !session) {
        out.push(buildEvidence({
          ...common,
          status: "error",
          observation: {},
          detail: [
            result.spawn_error
              ? `failed to run eve: ${result.spawn_error}`
              : result.timed_out
                ? "eve session exceeded its timeout"
                : "could not parse an EVE SessionResult from the output (expected --json)",
          ],
          provenance: { ...result, seed },
          artifactDigest: artifact,
        }));
        continue;
      }

      out.push(buildEvidence({
        ...common,
        status: "collected",
        observation: observe(session, seed),
        detail: describe(session),
        provenance: { ...result, seed: session.seed ?? seed },
        artifactDigest: artifact,
      }));
    }

    return out;
  },
};

function defaultCommand(
  req: CollectionTarget["requirement"],
  url: string,
  seed: number,
): string[] {
  const command = ["npx", "eve", "run", url, "--json", "--seed", String(seed)];
  const persona = configString(req, "persona");
  if (persona) command.push("--persona", persona);
  const goal = configString(req, "goal");
  if (goal) command.push("--goal", goal);
  return command;
}

function observe(session: SessionResult, fallbackSeed: number): Record<string, ObservedValue> {
  const findings = session.findings ?? [];
  const bySeverity = (s: string) => findings.filter((f) => f.severity === s).length;

  return {
    seed: session.seed ?? fallbackSeed,
    goal_achieved: session.goalAchieved ?? false,
    abandoned: session.abandoned ?? false,
    overall_score: session.scores?.find((s) => s.dimension === "overall")?.value ?? 0,
    critical_findings: bySeverity("critical"),
    major_findings: bySeverity("major"),
    total_findings: findings.length,
    steps: session.usage?.steps ?? 0,
  };
}

function describe(session: SessionResult): string[] {
  const detail: string[] = [];
  const overall = session.scores?.find((s) => s.dimension === "overall")?.value;

  detail.push(
    `persona "${session.personaName ?? "unknown"}" on ${session.startUrl ?? "unknown url"} ` +
      `(seed ${session.seed ?? "?"}): ` +
      (session.abandoned
        ? `gave up — ${session.abandonReason ?? "frustration exceeded tolerance"}`
        : session.goalAchieved
          ? "achieved the goal"
          : `did not complete — ${session.endReason ?? "ran out of steps"}`),
  );

  if (overall !== undefined) detail.push(`overall experience score ${overall}/100`);

  for (const finding of (session.findings ?? []).filter((f) => f.severity === "critical").slice(0, 5)) {
    detail.push(`critical: ${finding.title ?? "(untitled)"}`);
  }

  return detail;
}

export function parseSession(text: string): SessionResult | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      // EVE's CLI may wrap the session under `result`.
      const session = (parsed["result"] ?? parsed) as SessionResult;
      if (session && typeof session === "object" && ("goalAchieved" in session || "findings" in session)) {
        return session;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}
