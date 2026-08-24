/**
 * Genesis — assurance infrastructure for machine-authored work.
 *
 * Audits RLVR verifiers, eval harnesses, and benchmark graders for exploitable
 * defects: fires adversarial probes at a verifier and reports which of a
 * published taxonomy's defect classes it has.
 */

export { runAudit, AuditError, AUDIT_EXIT } from "./assurance/audit.js";
export type { AuditOptions, AuditRecord } from "./assurance/audit.js";
export { concludeAudit, classifyOutcome } from "./assurance/findings.js";
export type { AuditConclusion, AuditMetrics, Finding, ProbeOutcome, ProbeResult, Severity } from "./assurance/findings.js";
export { suiteDigest, validateSuite, exploitProbes, controlProbes } from "./assurance/probe.js";
export type { Probe, ProbeSuite, ProbeTask } from "./assurance/probe.js";
export { SUITES, getSuite, suiteNames } from "./assurance/suites/index.js";
export { TAXONOMY, DEFECT_CLASSES, DOMAINS, descriptorsFor } from "./assurance/taxonomy.js";
export type { DefectClass, DefectDescriptor, Domain } from "./assurance/taxonomy.js";
export { VerifierAdapter, parseJsonLoose } from "./assurance/verifier.js";
export type { AcceptRule, Observed, VerifierConfig, VerifierResponse } from "./assurance/verifier.js";
export { renderAudit } from "./assurance/report.js";

export { Ledger, computeEntryHash } from "./ledger/ledger.js";
export type { ChainVerification, EntryType, LedgerEntry } from "./ledger/ledger.js";

export { wilson, formatInterval } from "./backtest/metrics.js";
export type { Interval } from "./backtest/metrics.js";

export { computeEnvDigest, SubprocessRunner } from "./evidence/runner.js";
export type { Runner, RunResult } from "./evidence/runner.js";

export { canonicalize, hashCanonical, sha256, ZERO_HASH } from "./shared/canonical.js";
export { redact, registerSecret } from "./shared/redact.js";
