/**
 * Offline single-file HTML reports, rendered FROM the evidence bundle.
 *
 * Every evidence bundle ships a `report.html`: verdict banner, metric
 * intervals, findings, comparisons, and an expandable per-trial explorer —
 * all inline CSS + vanilla JS, zero external resources, works from file://.
 * The bundle stays the source of truth; the HTML is a lens, never a
 * replacement. All interpolated strings are HTML-escaped (trial outputs
 * may contain markup or script tags).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentResult } from "./runner.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const VERDICT_COLORS: Record<string, string> = {
  SUPPORTED: "#3fb950",
  FALSIFIED: "#f85149",
  INCONCLUSIVE: "#d29922",
  INVALID: "#a371f7",
  UNTESTED: "#8b949e",
  TRUSTED: "#3fb950",
  UNTRUSTED: "#f85149",
};

interface TrialRow {
  trial_id: string;
  task_id: string;
  repetition: number;
  subject: string;
  duration_ms: number;
  output: string;
  passed: boolean | null;
  score: number | string | null;
}

export function renderHtmlReport(result: ExperimentResult, trials?: readonly TrialRow[]): string {
  const v = result.verdict;
  const color = VERDICT_COLORS[v.verdict] ?? "#8b949e";
  const rows = trials ?? result.arms.flatMap((a) =>
    a.trials.map((t) => {
      const obs = a.observations.find((o) => o.trial_id === t.trial_id);
      return {
        trial_id: t.trial_id,
        task_id: t.task_id,
        repetition: t.repetition,
        subject: t.subject,
        duration_ms: t.duration_ms,
        output: excerpt(t.output),
        passed: obs?.passed ?? null,
        score: typeof obs?.score === "number" ? obs.score : null,
      };
    }),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Genesis report — ${escapeHtml(result.name)} — ${escapeHtml(v.verdict)}</title>
<style>
:root{color-scheme:dark}
body{background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#8b949e;margin:0 0 16px}
.banner{border:1px solid #30363d;border-left:6px solid ${color};border-radius:6px;padding:12px 16px;margin:16px 0}
.banner .v{font-size:20px;font-weight:700;color:${color}}
.card{border:1px solid #30363d;border-radius:6px;padding:12px 16px;margin:12px 0;background:#161b22}
.card h2{font-size:15px;margin:0 0 8px;color:#e6edf3}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:600}
.bar{position:relative;height:8px;background:#21262d;border-radius:4px;min-width:120px}
.bar .fill{position:absolute;top:0;bottom:0;background:#1f6feb;border-radius:4px}
.bar .pt{position:absolute;top:-3px;width:2px;height:14px;background:#e6edf3}
.chip{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid #30363d}
.pass{color:#3fb950;border-color:#3fb950}.fail{color:#f85149;border-color:#f85149}.null{color:#8b949e}
details.trial{border:1px solid #21262d;border-radius:6px;margin:6px 0;padding:6px 10px;background:#0d1117}
details.trial summary{cursor:pointer;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:#161b22;border:1px solid #21262d;border-radius:6px;padding:8px;font-size:12px;max-height:300px;overflow:auto}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:#8b949e}
.sev-critical,.sev-exploitable{color:#f85149}.sev-major{color:#ff7b72}.sev-minor{color:#d29922}.sev-info,.sev-brittle{color:#8b949e}.sev-over_strict{color:#a371f7}
input#q{background:#0d1117;border:1px solid #30363d;color:#e6edf3;border-radius:6px;padding:6px 10px;width:280px;margin:8px 0}
</style>
</head>
<body>
<h1>${escapeHtml(result.name)}</h1>
<p class="sub">Genesis evidence report · ${escapeHtml(result.started_at)} → ${escapeHtml(result.ended_at)} · no backend, no network — this file is the report</p>
<div class="banner"><span class="v">${escapeHtml(v.verdict)}</span><br>${escapeHtml(v.summary)}</div>
<div class="card"><h2>Scope</h2>
<table>
<tr><th>Tested</th><td>${escapeHtml(v.scope.tested).slice(0, 500)}</td></tr>
<tr><th>Not tested</th><td>${escapeHtml(v.scope.not_tested)}</td></tr>
<tr><th>Dataset</th><td class="mono">${escapeHtml(v.scope.dataset)} (${escapeHtml(v.scope.dataset_digest.slice(0, 20))}…)</td></tr>
<tr><th>Samples</th><td>N=${v.scope.sample_size}, repetitions=${v.scope.repetitions}</td></tr>
<tr><th>Metrics</th><td class="mono">${escapeHtml(v.scope.metrics.join(", "))}</td></tr>
</table></div>
${result.arms.map(renderArm).join("\n")}
${result.comparisons.length > 0 ? `<div class="card"><h2>Comparisons (paired, descriptive)</h2><table><tr><th>Metric</th><th>Baseline</th><th>Treatment</th><th>Δ</th><th>95% CI of Δ</th></tr>${result.comparisons.map((c) => `<tr><td class="mono">${escapeHtml(c.metric)}</td><td>${fmt(c.baseline_mean)}</td><td>${fmt(c.treatment_mean)}</td><td>${fmt(c.delta)}</td><td class="mono">[${fmt(c.ci95_delta.low)}, ${fmt(c.ci95_delta.high)}]</td></tr>`).join("")}</table></div>` : ""}
${result.findings.length > 0 ? `<div class="card"><h2>Findings (${result.findings.length})</h2>${result.findings.map((f) => `<p><span class="chip sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span> <strong>${escapeHtml(f.category)}</strong> — ${escapeHtml(f.summary)}${f.possible_cause ? `<br><span class="mono">possible cause: ${escapeHtml(f.possible_cause)}</span>` : ""}</p>`).join("")}</div>` : ""}
${v.hypothesis_results?.length ? `<div class="card"><h2>Hypotheses</h2><table>${v.hypothesis_results.map((h) => `<tr><td>${h.satisfied === true ? "✓" : h.satisfied === false ? "✗" : "?"}</td><td class="mono">${escapeHtml(h.metric)} ${escapeHtml(h.operator)} ${h.threshold}</td><td>observed ${h.observed === null ? "n/a" : fmt(h.observed)}</td></tr>`).join("")}</table></div>` : ""}
<div class="card"><h2>Trials (${rows.length})</h2>
<input id="q" type="search" placeholder="filter by task, trial, or output…" oninput="filter Trials(this.value)">
<div id="trials">${rows.map(renderTrial).join("")}</div></div>
<script>
function filterTrials(q){q=q.toLowerCase();for(const d of document.querySelectorAll("details.trial")){d.style.display=d.textContent.toLowerCase().includes(q)?"":"none"}}
</script>
</body>
</html>`;
}

function renderArm(arm: ExperimentResult["arms"][number]): string {
  const rows = arm.metrics.map((m) => {
    const stat = arm.statistics.find((s) => s?.metric === m.metric);
    const bar = stat ? ciBar(stat.ci95.low, stat.ci95.high, stat.mean) : "";
    const interval = stat ? `[${fmt(stat.ci95.low)}–${fmt(stat.ci95.high)}, n=${stat.n}]` : `[n=${m.n}, no interval]`;
    return `<tr><td class="mono">${escapeHtml(m.metric)}</td><td>${fmt(m.value)}${m.unit ? ` ${escapeHtml(m.unit)}` : ""}</td><td class="mono">${interval}</td><td>${bar}</td></tr>`;
  }).join("");
  return `<div class="card"><h2>Arm: ${escapeHtml(arm.arm)} — ${arm.trials.length} trials</h2><table><tr><th>Metric</th><th>Value</th><th>Interval</th><th></th></tr>${rows}</table></div>`;
}

function ciBar(low: number, high: number, mean: number): string {
  const lo = Math.max(0, Math.min(1, low));
  const hi = Math.max(0, Math.min(1, high));
  const mu = Math.max(0, Math.min(1, mean));
  return `<div class="bar"><div class="fill" style="left:${(lo * 100).toFixed(1)}%;width:${Math.max(0.5, (hi - lo) * 100).toFixed(1)}%"></div><div class="pt" style="left:${(mu * 100).toFixed(1)}%"></div></div>`;
}

function renderTrial(t: TrialRow): string {
  const chip = t.passed === true
    ? `<span class="chip pass">pass</span>`
    : t.passed === false ? `<span class="chip fail">fail</span>` : `<span class="chip null">unjudged</span>`;
  return `<details class="trial"><summary>${chip} <span class="mono">${escapeHtml(t.task_id)} · ${escapeHtml(t.trial_id)} · rep ${t.repetition} · ${t.duration_ms}ms${t.score !== null ? ` · score ${fmt(Number(t.score))}` : ""}</span><br>${escapeHtml(t.output.slice(0, 160))}</summary><pre>${escapeHtml(t.output)}</pre></details>`;
}

function excerpt(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 2000 ? `${s.slice(0, 2000)}\n…(truncated)` : s;
}

function fmt(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

/**
 * Regenerate the report from a bundle directory (verdict + metrics +
 * findings + statistics + results.jsonl). Used by `genesis report --html`.
 */
export function renderHtmlFromBundle(dir: string): string {
  const read = (rel: string): unknown => JSON.parse(readFileSync(join(dir, rel), "utf8"));
  const verdict = read("verdict.json") as ExperimentResult["verdict"];
  const findings = read("findings.json") as ExperimentResult["findings"];
  const statistics = read("statistics.json") as {
    arms: { arm: string; statistics: ExperimentResult["arms"][number]["statistics"] }[];
    comparisons: ExperimentResult["comparisons"];
  };
  const arms: ExperimentResult["arms"] = [];
  for (const armDir of ["treatment", "baseline"]) {
    const metricsPath = join(dir, armDir, "metrics.json");
    const resultsPath = join(dir, armDir, "results.jsonl");
    if (!existsSync(metricsPath) || !existsSync(resultsPath)) continue;
    const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as ExperimentResult["arms"][number]["metrics"];
    const trials: ExperimentResult["arms"][number]["trials"] = [];
    const observations: ExperimentResult["arms"][number]["observations"] = [];
    for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      if (trials.length >= 500) break;
      try {
        const row = JSON.parse(t) as { trial: (typeof trials)[number]; observation: (typeof observations)[number] };
        trials.push(row.trial);
        if (row.observation) observations.push(row.observation);
      } catch {
        // Skip corrupt lines; the JSONL remains authoritative.
      }
    }
    const stats = statistics.arms.find((a) => a.arm === armDir)?.statistics ?? [];
    arms.push({ arm: armDir, trials, observations, evidence: [], metrics, statistics: stats });
  }
  for (const entry of readdirSync(dir)) {
    if (entry !== "treatment" && entry !== "baseline" && existsSync(join(dir, entry, "metrics.json"))) {
      try {
        const metrics = JSON.parse(readFileSync(join(dir, entry, "metrics.json"), "utf8")) as ExperimentResult["arms"][number]["metrics"];
        arms.push({ arm: entry, trials: [], observations: [], evidence: [], metrics, statistics: [] });
      } catch {
        // Skip unreadable arms.
      }
    }
  }
  return renderHtmlReport({
    name: `${verdict.scope.dataset} report`,
    dataset: { id: verdict.scope.dataset, version: "", digest: verdict.scope.dataset_digest, task_count: verdict.scope.sample_size, schema: {}, provenance: {} },
    spec_digest: "",
    arms,
    comparisons: statistics.comparisons,
    verdict,
    findings,
    started_at: "",
    ended_at: "",
  });
}
