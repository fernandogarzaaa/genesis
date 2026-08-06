/**
 * Git queries used by the diff collector and the pre-registration check.
 *
 * All read-only. Genesis has no write path to the repository under evaluation.
 */

import { execFileSync } from "node:child_process";

export class GitError extends Error {
  override readonly name = "GitError";
}

function git(repoPath: string, args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`git ${args.join(" ")}: ${message}`);
  }
}

function tryGit(repoPath: string, args: readonly string[]): string | null {
  try {
    return git(repoPath, args);
  } catch {
    return null;
  }
}

export function isGitRepo(repoPath: string): boolean {
  return tryGit(repoPath, ["rev-parse", "--git-dir"]) !== null;
}

export function resolveRef(repoPath: string, ref: string): string | null {
  return tryGit(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function isAncestor(repoPath: string, ancestor: string, descendant: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoPath,
      stdio: "ignore",
    });
    return true;
  } catch (error) {
    // Exit 1 means "not an ancestor" — a real answer. Anything else (128:
    // unknown revision, shallow clone) means we could not determine it.
    const code = (error as { status?: number }).status;
    return code === 1 ? false : null;
  }
}

export function changedFiles(repoPath: string, base: string, head: string): string[] {
  const out = tryGit(repoPath, ["diff", "--name-only", `${base}...${head}`]);
  if (out === null) return [];
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export interface DiffStat {
  readonly files_changed: number;
  readonly insertions: number;
  readonly deletions: number;
}

export function diffStat(repoPath: string, base: string, head: string): DiffStat {
  const out = tryGit(repoPath, ["diff", "--numstat", `${base}...${head}`]);
  if (out === null || out === "") return { files_changed: 0, insertions: 0, deletions: 0 };

  let insertions = 0;
  let deletions = 0;
  let files = 0;

  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    files += 1;
    // "-" appears for binary files.
    const added = Number(parts[0]);
    const removed = Number(parts[1]);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(removed)) deletions += removed;
  }

  return { files_changed: files, insertions, deletions };
}

/** ISO timestamp of the earliest commit in `base..head`, or null if none. */
export function firstCommitDate(repoPath: string, base: string, head: string): string | null {
  const out = tryGit(repoPath, ["log", "--reverse", "--format=%aI", `${base}..${head}`]);
  if (!out) return null;
  const first = out.split("\n")[0]?.trim();
  return first || null;
}

export function commitCount(repoPath: string, base: string, head: string): number | null {
  const out = tryGit(repoPath, ["rev-list", "--count", `${base}..${head}`]);
  if (out === null) return null;
  const n = Number(out);
  return Number.isFinite(n) ? n : null;
}
