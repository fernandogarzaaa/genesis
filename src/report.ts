/**
 * Human-readable verdict rendering.
 *
 * Every failed criterion cites the artifact digest that produced it. The
 * remediation section is advisory prose, labelled as such — it is the one place
 * judgment appears in the output, and it has no bearing on the verdict above it.
 */

import type { Adjudication, CriterionFinding } from "./adjudicator/index.js";
import type { FrozenContract } from "./contract/schema.js";
import type { VerifyResult } from "./verify.js";

const SYMBOL = { satisfied: "✓", violated: "✗", unproven: "!" } as const;

export function renderVerdict(
  contract: FrozenContract,
  result: VerifyResult,
  options: { color?: boolean } = {},
): string {
  const { adjudication } = result;
  const lines: string[] = [];
  const paint = painter(options.color ?? false);

  const evidenceCount = result.evidence.length;
  const criteriaCount = contract.criteria.length;

  lines.push("");
  lines.push(paint(`VERDICT: ${adjudication.verdict.replace("_", " ")}`, verdictColor(adjudication.verdict)));
  lines.push(
    `Contract ${contract.contract_hash.slice(0, 12)} ` +
      `(${contract.provenance}, frozen ${contract.created_at}, base ${contract.repo.base_commit.slice(0, 8)})`,
  );
  lines.push(
    `Evaluated ${criteriaCount} criteria against ${evidenceCount} evidence record(s) ` +
      `at ${result.headCommit.slice(0, 8)} · adjudicator ${adjudication.adjudicator_version}`,
  );
  lines.push("");

  section(lines, "FAILED", adjudication.criteria.filter((c) => c.state === "FAILED"), paint, "fail");
  section(lines, "UNPROVEN", adjudication.criteria.filter((c) => c.state === "UNPROVEN"), paint, "warn");
  section(lines, "CONTESTED", adjudication.criteria.filter((c) => c.state === "CONTESTED"), paint, "warn");

  const satisfied = adjudication.criteria.filter((c) => c.state === "SATISFIED");
  if (satisfied.length > 0) {
    lines.push(paint(`SATISFIED (${satisfied.length})`, "pass"));
    lines.push(`  ${satisfied.map((c) => c.criterion_id).join(", ")}`);
    lines.push("");
  }

  const advisory = adjudication.criteria.filter((c) => !c.binding);
  if (advisory.length > 0) {
    lines.push(`ADVISORY (${advisory.length}, non-binding — recorded but never blocking)`);
    for (const criterion of advisory) {
      lines.push(`  ${criterion.criterion_id}  ${criterion.state.toLowerCase()}  ${criterion.statement}`);
    }
    lines.push("");
  }

  if (result.rejected.length > 0) {
    lines.push(`INADMISSIBLE (${result.rejected.length}) — recorded in the ledger, excluded from the verdict`);
    for (const { evidence, reason } of result.rejected.slice(0, 10)) {
      lines.push(`  ${evidence.criterion_id}/${evidence.requirement_id}: ${reason}`);
    }
    lines.push("");
  }

  lines.push("WHY");
  for (const reason of adjudication.rationale) lines.push(`  ${wrap(reason, 76, "  ")}`);
  lines.push("");

  const remediation = suggestRemediation(adjudication);
  if (remediation.length > 0) {
    lines.push("SUGGESTED REMEDIATION (advisory — does not affect the verdict above)");
    remediation.forEach((item, i) => {
      lines.push(`  ${i + 1}. ${wrap(item, 74, "     ")}`);
    });
    lines.push("");
  }

  lines.push(`Ledger: entry ${result.verdictEntryHash.slice(0, 12)}`);
  lines.push("");

  return lines.join("\n");
}

function section(
  lines: string[],
  heading: string,
  criteria: readonly CriterionFinding[],
  paint: (s: string, c: Tone) => string,
  tone: Tone,
): void {
  const binding = criteria.filter((c) => c.binding);
  if (binding.length === 0) return;

  lines.push(paint(`${heading} (${binding.length})`, tone));
  lines.push("");

  for (const criterion of binding) {
    lines.push(`  ${criterion.criterion_id}  ${criterion.statement}`);
    for (const requirement of criterion.requirements) {
      const mark = SYMBOL[requirement.state];
      lines.push(`    ${mark} ${requirement.collector} · ${requirement.reason}`);
      if (requirement.artifact_digest) {
        lines.push(`        artifact ${requirement.artifact_digest.slice(0, 16)}`);
      }
    }
    lines.push("");
  }
}

function suggestRemediation(adjudication: Adjudication): string[] {
  const items: string[] = [];

  for (const criterion of adjudication.criteria) {
    if (!criterion.binding) continue;

    if (criterion.state === "FAILED") {
      const violated = criterion.requirements.filter((r) => r.state === "violated");
      items.push(`${criterion.criterion_id} — ${violated.map((r) => r.reason).join("; ")}`);
    } else if (criterion.state === "UNPROVEN") {
      const unproven = criterion.requirements.filter((r) => r.state === "unproven");
      items.push(
        `${criterion.criterion_id} — ${unproven.map((r) => `${r.collector}: ${r.reason}`).join("; ")}`,
      );
    } else if (criterion.state === "CONTESTED") {
      items.push(
        `${criterion.criterion_id} — mechanical evidence passes but judgmental review disagrees; a human should look`,
      );
    }
  }

  return items;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

type Tone = "pass" | "fail" | "warn" | "plain";

function painter(enabled: boolean): (s: string, tone: Tone) => string {
  if (!enabled) return (s) => s;
  const codes: Record<Tone, string> = {
    pass: "[32m", fail: "[31m", warn: "[33m", plain: "",
  };
  return (s, tone) => (codes[tone] ? `${codes[tone]}${s}[0m` : s);
}

function verdictColor(verdict: Adjudication["verdict"]): Tone {
  return verdict === "SHIP" ? "pass" : verdict === "NOT_READY" ? "fail" : "warn";
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);

  return lines.join(`\n${indent}`);
}
