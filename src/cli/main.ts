/**
 * Genesis CLI.
 *
 * Exit codes are distinct on purpose: a CI integration must be able to block on
 * NOT READY and route HUMAN REVIEW to a person without parsing stdout, and
 * Genesis failing (3) must never be confusable with a repository failing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ADJUDICATOR_VERSION } from "../adjudicator/index.js";
import { amendContract, draftContract, freezeContract } from "../contract/freeze.js";
import { validateContract } from "../contract/validate.js";
import type { FrozenContract } from "../contract/schema.js";
import { defaultRegistry } from "../evidence/collectors.js";
import { resolveRef } from "../evidence/git.js";
import { Ledger, type OutcomeLabel } from "../ledger/ledger.js";
import { backtestDataset, backtestLedger, type DatasetCase } from "../backtest/index.js";
import { formatInterval, type BacktestSummary } from "../backtest/metrics.js";
import { renderVerdict } from "../report.js";
import { EXIT_CODES, exitCodeFor, verify, VerifyError } from "../verify.js";
import { AuditError, exitCodeFor as auditExitCode, runAudit } from "../assurance/audit.js";
import { EveOracleAdapter } from "../assurance/eve-oracle-adapter.js";
import { renderAudit } from "../assurance/report.js";
import { getSuite, suiteNames } from "../assurance/suites/index.js";
import { ALL_DESCRIPTORS } from "../assurance/findings.js";
import { VerifierAdapter, type AcceptRule, type Judge } from "../assurance/verifier.js";
import { SubprocessRunner } from "../evidence/runner.js";

const VERSION = "0.1.0";
const DEFAULT_LEDGER = ".genesis/ledger.db";

const USAGE = `genesis ${VERSION} — the acceptance layer for machine-authored work

  genesis contract init      --objective <text|@file> [--repo .] [--base <ref>] [--out contract.json]
  genesis contract validate  --contract <file>
  genesis contract freeze    --contract <file> [--ledger <db>] [--out <file>]
  genesis contract amend     --contract <file> --reason <text> --author <name> [--ledger <db>]

  genesis verify             --contract <file> [--repo .] [--head HEAD] [--ledger <db>] [--json]
                             exit 0 = SHIP · 1 = NOT READY · 2 = HUMAN REVIEW · 3 = internal error

  genesis label              --contract <hash> --outcome <merged_clean|reverted|hotfixed|rejected>
                             [--source <manual|github_webhook|backfill>] [--ledger <db>]

  genesis ledger verify      [--ledger <db>]
  genesis ledger export      [--ledger <db>]
  genesis ledger show        --contract <hash> [--ledger <db>]

  genesis backtest           [--from-ledger | --dataset <file.jsonl>] [--ledger <db>] [--json]

  genesis collectors         list registered evidence collectors

  genesis audit              --suite <code|json|math|behavioral> [--ledger <db>] [--json] [--verbose]
                             and exactly one of:
                               --verifier "<cmd with {task_file} {completion_file}>"  (code/json/math)
                               --oracle eve [--eve-bin "<cmd>"]                       (behavioral)
                             [--name <label>] [--accept exit_zero|json_reward|json_pass]
                             [--threshold <n>] [--timeout <ms>]
                             exit 0 = SOUND · 1 = EXPLOITABLE · 2 = UNRELIABLE/OVER_STRICT · 3 = internal error

  genesis suites             list probe suites and the defect classes they cover
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command, subcommand] = argv;

  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE);
        return 0;

      case "-v":
      case "--version":
        process.stdout.write(`genesis ${VERSION} (adjudicator ${ADJUDICATOR_VERSION})\n`);
        return 0;

      case "contract":
        return cmdContract(subcommand, argv.slice(2));

      case "verify":
        return await cmdVerify(argv.slice(1));

      case "label":
        return cmdLabel(argv.slice(1));

      case "ledger":
        return cmdLedger(subcommand, argv.slice(2));

      case "backtest":
        return cmdBacktest(argv.slice(1));

      case "collectors":
        for (const name of defaultRegistry().names()) process.stdout.write(`${name}\n`);
        return 0;

      case "audit":
        return await cmdAudit(argv.slice(1));

      case "suites":
        return cmdSuites();

      default:
        fail(`unknown command "${command}"`);
        process.stderr.write(USAGE);
        return EXIT_CODES.INTERNAL_ERROR;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
    return EXIT_CODES.INTERNAL_ERROR;
  }
}

// ── contract ────────────────────────────────────────────────────────────────

function cmdContract(subcommand: string | undefined, argv: readonly string[]): number {
  switch (subcommand) {
    case "init": {
      const { values } = parseArgs({
        args: [...argv],
        options: {
          objective: { type: "string" },
          repo: { type: "string", default: "." },
          base: { type: "string", default: "HEAD" },
          out: { type: "string", default: "contract.json" },
          provenance: { type: "string", default: "pre_registered" },
        },
        allowPositionals: false,
      });

      if (!values.objective) return usageError("--objective is required");

      const repoPath = resolve(values.repo ?? ".");
      const baseCommit = resolveRef(repoPath, values.base ?? "HEAD") ?? values.base ?? "HEAD";

      const contract = draftContract({
        objective: readInline(values.objective),
        baseCommit,
        provenance: values.provenance === "reconstructed" ? "reconstructed" : "pre_registered",
      });

      writeJson(values.out ?? "contract.json", contract);
      process.stdout.write(
        `Draft contract written to ${values.out}\n` +
          `Base commit: ${baseCommit.slice(0, 12)}\n\n` +
          "Replace the EXAMPLE criterion with falsifiable ones, then run:\n" +
          `  genesis contract validate --contract ${values.out}\n` +
          `  genesis contract freeze   --contract ${values.out}\n\n` +
          "Freeze before implementation begins. Genesis will not certify a contract\n" +
          "it cannot prove came first.\n",
      );
      return 0;
    }

    case "validate": {
      const { values } = parseArgs({
        args: [...argv],
        options: { contract: { type: "string" } },
        allowPositionals: false,
      });
      if (!values.contract) return usageError("--contract is required");

      const result = validateContract(readJson(values.contract), defaultRegistry().names());

      for (const warning of result.warnings) {
        process.stdout.write(`warning  ${warning.path}: ${warning.message}\n`);
      }
      for (const error of result.errors) {
        process.stderr.write(`error    ${error.path}: ${error.message}\n`);
      }

      if (!result.ok) {
        process.stderr.write(`\n${result.errors.length} error(s). Contract is not valid.\n`);
        return EXIT_CODES.INTERNAL_ERROR;
      }

      const criteria = result.contract?.criteria.length ?? 0;
      const binding = result.contract?.criteria.filter((c) => c.binding).length ?? 0;
      process.stdout.write(`\nValid. ${criteria} criteria (${binding} binding), ${result.warnings.length} warning(s).\n`);
      return 0;
    }

    case "freeze": {
      const { values } = parseArgs({
        args: [...argv],
        options: {
          contract: { type: "string" },
          ledger: { type: "string", default: DEFAULT_LEDGER },
          out: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!values.contract) return usageError("--contract is required");

      const validation = validateContract(readJson(values.contract), defaultRegistry().names());
      if (!validation.ok || !validation.contract) {
        for (const error of validation.errors) {
          process.stderr.write(`error  ${error.path}: ${error.message}\n`);
        }
        process.stderr.write("\nRefusing to freeze an invalid contract.\n");
        return EXIT_CODES.INTERNAL_ERROR;
      }

      const frozen = freezeContract(validation.contract);
      const ledger = openLedger(values.ledger);
      try {
        const entry = ledger.registerContract(frozen);
        writeJson(values.out ?? values.contract, frozen);
        process.stdout.write(
          `Frozen.\n` +
            `  contract_hash  ${frozen.contract_hash}\n` +
            `  base_commit    ${frozen.repo.base_commit}\n` +
            `  ledger entry   ${entry.entry_hash.slice(0, 16)} (seq ${entry.seq})\n` +
            `  provenance     ${frozen.provenance}\n`,
        );
        return 0;
      } finally {
        ledger.close();
      }
    }

    case "amend": {
      const { values } = parseArgs({
        args: [...argv],
        options: {
          contract: { type: "string" },
          reason: { type: "string" },
          author: { type: "string" },
          ledger: { type: "string", default: DEFAULT_LEDGER },
          out: { type: "string" },
        },
        allowPositionals: false,
      });
      if (!values.contract) return usageError("--contract is required");
      if (!values.reason) return usageError("--reason is required; amendments are never silent");
      if (!values.author) return usageError("--author is required");

      const prior = readJson(values.contract) as FrozenContract;
      if (!prior.contract_hash) return usageError("that contract has not been frozen, so there is nothing to amend");

      const validation = validateContract(prior, defaultRegistry().names());
      if (!validation.ok || !validation.contract) {
        for (const error of validation.errors) {
          process.stderr.write(`error  ${error.path}: ${error.message}\n`);
        }
        return EXIT_CODES.INTERNAL_ERROR;
      }

      const amended = amendContract(prior, validation.contract, {
        reason: values.reason,
        author: values.author,
        at: new Date().toISOString(),
      });

      const ledger = openLedger(values.ledger);
      try {
        const entry = ledger.registerContract(amended);
        writeJson(values.out ?? values.contract, amended);
        process.stdout.write(
          `Amended.\n` +
            `  contract_hash  ${amended.contract_hash}\n` +
            `  supersedes     ${amended.supersedes}\n` +
            `  ledger entry   ${entry.entry_hash.slice(0, 16)} (seq ${entry.seq})\n\n` +
            "The prior contract keeps its hash and its entry. If this amendment lands after\n" +
            "implementation began, the verdict ceiling drops to HUMAN REVIEW.\n",
        );
        return 0;
      } finally {
        ledger.close();
      }
    }

    default:
      return usageError(`unknown subcommand "contract ${subcommand ?? ""}"`);
  }
}

// ── verify ──────────────────────────────────────────────────────────────────

async function cmdVerify(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      contract: { type: "string" },
      repo: { type: "string", default: "." },
      head: { type: "string", default: "HEAD" },
      ledger: { type: "string", default: DEFAULT_LEDGER },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values.contract) return usageError("--contract is required");

  const contract = readJson(values.contract) as FrozenContract;
  const ledger = openLedger(values.ledger);

  try {
    const result = await verify({
      repoPath: resolve(values.repo ?? "."),
      contract,
      ledger,
      registry: defaultRegistry(),
      head: values.head,
      events: values.quiet || values.json
        ? {}
        : {
            onCollectorStart: (name, n) => process.stderr.write(`  collecting ${name} (${n} requirement(s))…\n`),
            onCollectorFinish: (name, produced, ms) =>
              process.stderr.write(`  ${name}: ${produced} record(s) in ${ms}ms\n`),
            onCollectorError: (name, error) => process.stderr.write(`  ${name} failed: ${error.message}\n`),
          },
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(
        {
          verdict: result.adjudication.verdict,
          contract_hash: contract.contract_hash,
          head_commit: result.headCommit,
          adjudicator_version: result.adjudication.adjudicator_version,
          criteria: result.adjudication.criteria,
          rationale: result.adjudication.rationale,
          counts: result.adjudication.counts,
          pre_registration: result.preRegistration,
          inadmissible: result.rejected.map((r) => ({ evidence_id: r.evidence.evidence_id, reason: r.reason })),
          ledger_entry: result.verdictEntryHash,
        },
        null,
        2,
      )}\n`);
    } else {
      process.stdout.write(renderVerdict(contract, result, { color: process.stdout.isTTY === true }));
    }

    return exitCodeFor(result.adjudication.verdict);
  } catch (error) {
    if (error instanceof VerifyError) {
      fail(error.message);
      return EXIT_CODES.INTERNAL_ERROR;
    }
    throw error;
  } finally {
    ledger.close();
  }
}

// ── label ───────────────────────────────────────────────────────────────────

const OUTCOMES: readonly OutcomeLabel[] = ["merged_clean", "reverted", "hotfixed", "rejected"];

function cmdLabel(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      contract: { type: "string" },
      outcome: { type: "string" },
      source: { type: "string", default: "manual" },
      detail: { type: "string" },
      ledger: { type: "string", default: DEFAULT_LEDGER },
    },
    allowPositionals: false,
  });

  if (!values.contract) return usageError("--contract is required (the contract hash)");
  if (!values.outcome || !OUTCOMES.includes(values.outcome as OutcomeLabel)) {
    return usageError(`--outcome must be one of: ${OUTCOMES.join(", ")}`);
  }

  const ledger = openLedger(values.ledger);
  try {
    const existing = ledger.entries({ type: "OUTCOME_LABELED", contract_hash: values.contract });
    const priorHash = existing.at(-1)?.entry_hash ?? null;

    const entry = ledger.labelOutcome(values.contract, {
      label: values.outcome as OutcomeLabel,
      label_source: (values.source ?? "manual") as "manual" | "github_webhook" | "backfill",
      verdict_entry_hash:
        ledger.entries({ type: "VERDICT_RENDERED", contract_hash: values.contract }).at(-1)?.entry_hash ?? null,
      detail: values.detail ? { note: values.detail } : {},
      supersedes: priorHash,
    });

    process.stdout.write(
      `Labeled ${values.contract.slice(0, 12)} as ${values.outcome}` +
        (priorHash ? " (supersedes an earlier label; the earlier one stays in the chain)" : "") +
        `\n  ledger entry ${entry.entry_hash.slice(0, 16)} (seq ${entry.seq})\n`,
    );
    return 0;
  } finally {
    ledger.close();
  }
}

// ── ledger ──────────────────────────────────────────────────────────────────

function cmdLedger(subcommand: string | undefined, argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { ledger: { type: "string", default: DEFAULT_LEDGER }, contract: { type: "string" } },
    allowPositionals: false,
  });

  const ledger = openLedger(values.ledger);
  try {
    switch (subcommand) {
      case "verify": {
        const result = ledger.verifyChain();
        if (result.ok) {
          process.stdout.write(
            `Chain intact. ${result.entries} entries.\n` +
              (result.head ? `Head: ${result.head}\n` : "Ledger is empty.\n"),
          );
          return 0;
        }
        process.stderr.write(
          `CHAIN BROKEN at seq ${result.brokenAt}\n  ${result.reason}\n\n` +
            "Entries at or after this point cannot be trusted. Restore from an export\n" +
            "(`genesis ledger export`) taken before the break.\n",
        );
        return EXIT_CODES.INTERNAL_ERROR;
      }

      case "export":
        for (const line of ledger.exportJsonl()) process.stdout.write(`${line}\n`);
        return 0;

      case "show": {
        if (!values.contract) return usageError("--contract is required (the contract hash)");
        const entries = ledger.entries({ contract_hash: values.contract });
        if (entries.length === 0) {
          process.stderr.write(`No ledger entries for contract ${values.contract}\n`);
          return EXIT_CODES.INTERNAL_ERROR;
        }
        for (const entry of entries) {
          process.stdout.write(
            `seq ${String(entry.seq).padStart(6)}  ${entry.entry_type.padEnd(20)}  ` +
              `${entry.entry_hash.slice(0, 16)}  ${new Date(entry.recorded_at).toISOString()}\n`,
          );
        }
        return 0;
      }

      default:
        return usageError(`unknown subcommand "ledger ${subcommand ?? ""}"`);
    }
  } finally {
    ledger.close();
  }
}

// ── backtest ────────────────────────────────────────────────────────────────

function cmdBacktest(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dataset: { type: "string" },
      "from-ledger": { type: "boolean", default: false },
      ledger: { type: "string", default: DEFAULT_LEDGER },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  let report;

  if (values.dataset) {
    const cases = readJsonl(values.dataset) as DatasetCase[];
    report = backtestDataset(cases);
  } else {
    const ledger = openLedger(values.ledger);
    try {
      report = backtestLedger(ledger);
    } finally {
      ledger.close();
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`\nBACKTEST · adjudicator ${report.adjudicator_version || "n/a"}\n`);
  process.stdout.write(`${report.cases.length} case(s) replayed, ${report.skipped.length} skipped\n`);

  if (report.summaries.length === 0) {
    process.stdout.write(
      "\nNothing to report. A verdict without an outcome is an opinion — label some\n" +
        "contracts with `genesis label --contract <hash> --outcome <label>` first.\n",
    );
    if (report.skipped.length > 0) {
      process.stdout.write("\nSkipped:\n");
      for (const s of report.skipped.slice(0, 20)) process.stdout.write(`  ${s.id}: ${s.reason}\n`);
    }
    return 0;
  }

  for (const summary of report.summaries) printSummary(summary);
  return 0;
}

function printSummary(summary: BacktestSummary): void {
  const out = process.stdout;

  out.write(`\n── ${summary.provenance.toUpperCase()} contracts (n=${summary.cases}) ──\n\n`);
  out.write(`  False-ship rate         ${formatInterval(summary.false_ship_rate)}\n`);
  out.write(`    P(SHIP | reverted or hotfixed) — the number that matters\n\n`);
  out.write(`  Block rate on clean     ${formatInterval(summary.block_rate_on_clean)}\n`);
  out.write(`    P(NOT READY | merged clean) — the adoption cost\n\n`);
  out.write(`  Coverage                ${formatInterval(summary.coverage)}\n`);
  out.write(`    P(verdict is not HUMAN REVIEW)\n\n`);
  out.write(`  Escalation precision    ${formatInterval(summary.escalation_precision)}\n`);
  out.write(`    P(problematic | HUMAN REVIEW) vs base rate ${formatInterval(summary.sample_problematic_rate)}\n\n`);

  out.write("  Confusion:\n");
  for (const cell of summary.confusion) {
    out.write(`    ${cell.verdict.padEnd(13)} × ${cell.outcome.padEnd(14)} ${cell.count}\n`);
  }

  if (summary.caveats.length > 0) {
    out.write("\n  CAVEATS\n");
    for (const caveat of summary.caveats) out.write(`    · ${caveat}\n`);
  }
  out.write("\n");
}

// ── audit ───────────────────────────────────────────────────────────────────

async function cmdAudit(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      verifier: { type: "string" },
      oracle: { type: "string" },
      "eve-bin": { type: "string", default: "npx eve" },
      suite: { type: "string" },
      name: { type: "string" },
      accept: { type: "string", default: "json_reward" },
      threshold: { type: "string" },
      field: { type: "string" },
      timeout: { type: "string", default: "30000" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values.suite) return usageError(`--suite is required, one of: ${suiteNames().join(", ")}`);
  const suite = getSuite(values.suite);
  if (!suite) return usageError(`unknown suite "${values.suite}", expected one of: ${suiteNames().join(", ")}`);

  if (!!values.verifier === (values.oracle !== undefined)) {
    return usageError(
      'pass exactly one of --verifier "<cmd with {task_file} {completion_file}>" (RLVR-style suites: ' +
        "code/json/math) or --oracle eve (behavioral-style suites: behavioral)",
    );
  }

  let judge: Judge;

  if (values.oracle !== undefined) {
    if (values.oracle !== "eve") {
      return usageError(`unknown --oracle "${values.oracle}"; the only behavioral judge available is "eve"`);
    }
    judge = new EveOracleAdapter(
      { bin: values["eve-bin"].trim().split(/\s+/), timeout_ms: Number(values.timeout ?? 30000) },
      new SubprocessRunner(),
    );
  } else {
    const command = (values.verifier as string).trim().split(/\s+/);
    if (!command.some((p) => p.includes("{task_file}")) || !command.some((p) => p.includes("{completion_file}"))) {
      return usageError("--verifier must contain both {task_file} and {completion_file} placeholders");
    }

    const accept = buildAcceptRule(values.accept, values.field, values.threshold);
    if (accept === null) {
      return usageError('--accept must be one of: exit_zero, json_reward, json_pass');
    }

    judge = new VerifierAdapter(
      {
        name: values.name ?? command[0] ?? "verifier",
        command,
        accept,
        timeout_ms: Number(values.timeout ?? 30000),
      },
      new SubprocessRunner(),
    );
  }

  // The ledger is optional here. An audit is useful as a one-shot check; it
  // becomes evidence only when someone needs to prove it happened.
  const ledger = values.ledger ? openLedger(values.ledger) : undefined;

  try {
    const record = await runAudit({
      verifier: judge,
      suite,
      ledger,
      events:
        values.json || values.verbose
          ? {}
          : {
              onProbeStart: (probe, i, total) =>
                process.stderr.write(`  [${i}/${total}] ${probe.id}…\n`),
            },
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      process.stdout.write(renderAudit(record, { verbose: values.verbose }));
    }

    return auditExitCode(record.conclusion.verdict);
  } catch (error) {
    if (error instanceof AuditError) {
      fail(error.message);
      return EXIT_CODES.INTERNAL_ERROR;
    }
    throw error;
  } finally {
    ledger?.close();
  }
}

function buildAcceptRule(
  kind: string | undefined,
  field: string | undefined,
  threshold: string | undefined,
): AcceptRule | null {
  switch (kind) {
    case "exit_zero":
      return { kind: "exit_zero" };
    case "json_pass":
      return { kind: "json_pass", ...(field ? { field } : {}) };
    case "json_reward":
    case undefined:
      return {
        kind: "json_reward",
        ...(field ? { field } : {}),
        ...(threshold ? { threshold: Number(threshold) } : {}),
      };
    default:
      return null;
  }
}

function cmdSuites(): number {
  for (const name of suiteNames()) {
    const suite = getSuite(name);
    if (!suite) continue;
    const exploits = suite.probes.filter((p) => p.expect === "reject");
    const controls = suite.probes.filter((p) => p.expect === "accept");
    const classes = [...new Set(exploits.map((p) => p.defect_class))].sort();

    process.stdout.write(
      `${name}@${suite.version}  ${exploits.length} exploit + ${controls.length} control probes\n`,
    );
    for (const id of classes) {
      process.stdout.write(`    ${id.padEnd(26)} ${ALL_DESCRIPTORS[id].defect}\n`);
    }
    process.stdout.write("\n");
  }
  return 0;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function openLedger(path: string | undefined): Ledger {
  const target = path ?? DEFAULT_LEDGER;
  if (target !== ":memory:") mkdirSync(dirname(resolve(target)), { recursive: true });
  return new Ledger(target);
}

function readInline(value: string): string {
  return value.startsWith("@") ? readFileSync(value.slice(1), "utf8").trim() : value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function usageError(message: string): number {
  fail(message);
  return EXIT_CODES.INTERNAL_ERROR;
}

function fail(message: string): void {
  process.stderr.write(`genesis: ${message}\n`);
}
