/**
 * Diff collector — blast radius of the change under evaluation.
 *
 * Test outcomes describe whether the code works. Diff shape describes how much
 * of the system the change could plausibly break, which is closer to the
 * actual causes of production reverts. Whether that intuition holds is an
 * empirical question the backtest answers; recording the signal is what makes
 * answering it possible.
 *
 *   config: { watched_paths?: string[] }   // e.g. ["src/auth/", "migrations/"]
 *   observes: files_changed, insertions, deletions, total_changes,
 *             watched_paths_touched, touches_watched_paths
 */

import type { Evidence, ObservedValue } from "../envelope.js";
import { changedFiles, diffStat, isGitRepo } from "../git.js";
import {
  buildEvidence,
  type Collector,
  type CollectionTarget,
  type CollectorContext,
} from "../registry.js";

export const ADAPTER_VERSION = "0.1.0";

export const diffCollector: Collector = {
  name: "diff",
  adapterVersion: ADAPTER_VERSION,

  async version(): Promise<string> {
    return "git";
  },

  async collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]> {
    const now = () => new Date().toISOString();
    const started_at = now();

    const common = {
      ctx,
      collectorName: "diff",
      collectorVersion: "git",
      adapterVersion: ADAPTER_VERSION,
    } as const;

    if (!isGitRepo(ctx.repoPath)) {
      return targets.map((target) =>
        buildEvidence({
          ...common,
          target,
          status: "error",
          observation: {},
          detail: [`${ctx.repoPath} is not a git repository`],
          provenance: { command: ["git"], exit_code: null, started_at, ended_at: now() },
        }),
      );
    }

    const stat = diffStat(ctx.repoPath, ctx.baseCommit, ctx.headCommit);
    const files = changedFiles(ctx.repoPath, ctx.baseCommit, ctx.headCommit);
    const ended_at = now();

    return targets.map((target) => {
      const watched = readWatchedPaths(target.requirement.config.watched_paths);
      const touched = files.filter((f) => watched.some((w) => f.startsWith(w)));

      const observation: Record<string, ObservedValue> = {
        files_changed: stat.files_changed,
        insertions: stat.insertions,
        deletions: stat.deletions,
        total_changes: stat.insertions + stat.deletions,
        watched_paths_touched: touched.length,
        touches_watched_paths: touched.length > 0,
      };

      const detail = [
        `${stat.files_changed} file(s), +${stat.insertions}/-${stat.deletions} between ` +
          `${ctx.baseCommit.slice(0, 8)} and ${ctx.headCommit.slice(0, 8)}`,
        ...touched.slice(0, 10).map((f) => `touches watched path: ${f}`),
      ];

      return buildEvidence({
        ...common,
        target,
        status: "collected",
        observation,
        detail,
        provenance: {
          command: ["git", "diff", "--numstat", `${ctx.baseCommit}...${ctx.headCommit}`],
          exit_code: 0,
          started_at,
          ended_at,
        },
      });
    });
  },
};

function readWatchedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
