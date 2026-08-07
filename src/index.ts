/**
 * Genesis — the acceptance layer for machine-authored work.
 *
 * Public API. The four pipeline components, in order:
 *   contract/   — compile, validate, freeze, amend
 *   evidence/   — collect, with a stable envelope and an admissibility rule
 *   adjudicator/— the pure verdict function
 *   ledger/     — hash-chained, append-only, outcome-labeled
 */

export { adjudicate, ADJUDICATOR_VERSION } from "./adjudicator/index.js";
export type {
  Adjudication,
  AdjudicationInput,
  CriterionFinding,
  CriterionState,
  PreRegistrationFacts,
  RequirementFinding,
  RequirementState,
  Verdict,
} from "./adjudicator/index.js";
export { evaluateAll, evaluateExpectation } from "./adjudicator/expect.js";

export {
  amendContract,
  computeContractHash,
  draftContract,
  freezeContract,
  normalizeContract,
  verifyContractHash,
} from "./contract/freeze.js";
export { validateContract } from "./contract/validate.js";
export type { ValidationResult } from "./contract/validate.js";
export * from "./contract/schema.js";

export { filterAdmissible, inadmissibleReason } from "./evidence/admissibility.js";
export { collectEvidence, makeContext } from "./evidence/collect.js";
export { defaultRegistry, CollectorRegistry } from "./evidence/collectors.js";
export { buildEvidence, errorEvidence } from "./evidence/registry.js";
export type { Collector, CollectorContext, CollectionTarget } from "./evidence/registry.js";
export { computeEnvDigest, SubprocessRunner } from "./evidence/runner.js";
export type { Runner, RunResult } from "./evidence/runner.js";
export { checkPreRegistration } from "./evidence/preregistration.js";
// `EvidenceKind` is re-exported from contract/schema.js above — the contract's
// declared kind and the envelope's kind are deliberately the same type.
export { sortEvidence } from "./evidence/envelope.js";
export type {
  CollectionStatus,
  Evidence,
  ObservedValue,
  Provenance,
} from "./evidence/envelope.js";

export { Ledger, LedgerError, computeEntryHash } from "./ledger/ledger.js";
export type { ChainVerification, EntryType, LedgerEntry, OutcomeLabel } from "./ledger/ledger.js";

export { backtestDataset, backtestLedger } from "./backtest/index.js";
export type { BacktestReport, DatasetCase } from "./backtest/index.js";
export { summarize, wilson, formatInterval, isProblematic } from "./backtest/metrics.js";
export type { BacktestCase, BacktestSummary, Interval } from "./backtest/metrics.js";

export { canonicalize, hashCanonical, sha256, ZERO_HASH } from "./shared/canonical.js";
export { redact, registerSecret } from "./shared/redact.js";

export { verify, VerifyError, EXIT_CODES, exitCodeFor } from "./verify.js";
export type { VerifyOptions, VerifyResult } from "./verify.js";

export { renderVerdict } from "./report.js";

// ── Assurance: auditing the verifier rather than the artifact ───────────────

export { runAudit, AuditError, AUDIT_EXIT } from "./assurance/audit.js";
export type { AuditOptions, AuditRecord } from "./assurance/audit.js";
export { concludeAudit, classifyOutcome } from "./assurance/findings.js";
export type {
  AuditConclusion,
  AuditMetrics,
  Finding,
  ProbeOutcome,
  ProbeResult,
  Severity,
} from "./assurance/findings.js";
export { suiteDigest, validateSuite, exploitProbes, controlProbes } from "./assurance/probe.js";
export type { Probe, ProbeSuite, ProbeTask } from "./assurance/probe.js";
export { SUITES, getSuite, suiteNames } from "./assurance/suites/index.js";
export { TAXONOMY, DEFECT_CLASSES, DOMAINS, descriptorsFor } from "./assurance/taxonomy.js";
export type { DefectClass, DefectDescriptor, Domain } from "./assurance/taxonomy.js";
export { VerifierAdapter, parseJsonLoose } from "./assurance/verifier.js";
export type { AcceptRule, Observed, VerifierConfig, VerifierResponse } from "./assurance/verifier.js";
export { renderAudit } from "./assurance/report.js";
