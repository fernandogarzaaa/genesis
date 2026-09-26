import { spawnSync } from "node:child_process";

let cached: string | null = null;

/**
 * Resolve a Python interpreter for command templates (`{python}`), tests,
 * and adapter harnesses. Prefers `python`, falls back to `python3`, and
 * throws a clear error when neither is on PATH. The PATH probe runs at
 * most once per process.
 */
export function resolvePython(): string {
  if (cached !== null) return cached;
  for (const bin of ["python", "python3"]) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
      if (!r.error && r.status === 0) {
        cached = bin;
        return bin;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "No Python interpreter found on PATH (tried `python`, then `python3`). " +
      "Install Python 3 or add it to PATH to run Python subjects, evaluators, and judges.",
  );
}
