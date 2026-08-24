/**
 * Genesis CLI.
 *
 * Exit codes are distinct on purpose: a CI integration must be able to block on
 * EXPLOITABLE without parsing stdout, and Genesis failing (3) must never be
 * confusable with a verifier failing.
 */

import { parseArgs } from "node:util";

import { AuditError, AUDIT_EXIT, exitCodeFor as auditExitCode, runAudit } from "../assurance/audit.js";
import { EveOracleAdapter } from "../assurance/eve-oracle-adapter.js";
import { renderAudit } from "../assurance/report.js";
import { getSuite, suiteNames } from "../assurance/suites/index.js";
import { ALL_DESCRIPTORS } from "../assurance/findings.js";
import { VerifierAdapter, type AcceptRule, type Judge } from "../assurance/verifier.js";
import { SubprocessRunner } from "../evidence/runner.js";
import { Ledger } from "../ledger/ledger.js";

const VERSION = "0.1.0";

const USAGE = `genesis ${VERSION} — audits verifiers, not artifacts

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
  const [command] = argv;

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
        process.stdout.write(`genesis ${VERSION}\n`);
        return 0;

      case "audit":
        return await cmdAudit(argv.slice(1));

      case "suites":
        return cmdSuites();

      default:
        fail(`unknown command "${command}"`);
        process.stderr.write(USAGE);
        return AUDIT_EXIT.INTERNAL_ERROR;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
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
  const ledger = values.ledger ? new Ledger(values.ledger) : undefined;

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
      return AUDIT_EXIT.INTERNAL_ERROR;
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

function usageError(message: string): number {
  fail(message);
  return AUDIT_EXIT.INTERNAL_ERROR;
}

function fail(message: string): void {
  process.stderr.write(`genesis: ${message}\n`);
}
