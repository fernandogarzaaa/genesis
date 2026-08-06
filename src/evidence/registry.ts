/**
 * The collector registry.
 *
 * Genesis never assumes any particular evidence producer. Collectors are
 * registered behind one stable interface; the Adjudicator only ever sees
 * envelopes. Adding a new evidence source — a fuzzer, a load test, a different
 * behavioral simulator — should require zero changes to the adjudication model.
 *
 * A collector receives *all* requirements addressed to it and returns one
 * envelope per requirement. That shape lets an expensive tool run once and
 * answer many requirements, without the collector deciding anything about
 * acceptance.
 */

import type { Criterion, Requirement } from "../contract/schema.js";
import type { Evidence, ObservedValue, Provenance } from "./envelope.js";
import type { Runner } from "./runner.js";

export interface CollectionTarget {
  readonly criterion: Criterion;
  readonly requirement: Requirement;
}

export interface CollectorContext {
  readonly repoPath: string;
  readonly contractHash: string;
  readonly headCommit: string;
  readonly baseCommit: string;
  readonly envDigest: string;
  readonly runner: Runner;
  /** Store raw output and return its digest. Redacts before hashing. */
  readonly putArtifact: (content: string) => string;
  /** Deterministic id generation, so tests can pin evidence ids. */
  readonly nextId: () => string;
}

export interface Collector {
  readonly name: string;
  readonly adapterVersion: string;
  /** Best-effort tool version. Recorded so drift is visible in calibration. */
  version(ctx: CollectorContext): Promise<string>;
  collect(targets: readonly CollectionTarget[], ctx: CollectorContext): Promise<Evidence[]>;
}

export class CollectorRegistry {
  readonly #collectors = new Map<string, Collector>();

  register(collector: Collector): this {
    this.#collectors.set(collector.name, collector);
    return this;
  }

  get(name: string): Collector | undefined {
    return this.#collectors.get(name);
  }

  names(): string[] {
    return [...this.#collectors.keys()].sort();
  }
}

// ── Envelope construction helpers, shared by every collector ────────────────

export interface BuildEvidenceArgs {
  readonly target: CollectionTarget;
  readonly ctx: CollectorContext;
  readonly collectorName: string;
  readonly collectorVersion: string;
  readonly adapterVersion: string;
  readonly status: Evidence["status"];
  readonly observation: Record<string, ObservedValue>;
  readonly detail?: readonly string[];
  readonly provenance: Pick<Provenance, "command" | "exit_code" | "started_at" | "ended_at"> &
    Partial<Pick<Provenance, "seed" | "produced_by">>;
  readonly artifactDigest?: string | null;
}

export function buildEvidence(args: BuildEvidenceArgs): Evidence {
  const { ctx, target, provenance } = args;
  return {
    evidence_id: ctx.nextId(),
    contract_hash: ctx.contractHash,
    criterion_id: target.criterion.id,
    requirement_id: target.requirement.id,
    kind: target.requirement.kind,
    collector: {
      name: args.collectorName,
      version: args.collectorVersion,
      adapter_version: args.adapterVersion,
    },
    status: args.status,
    observation: args.observation,
    detail: args.detail ?? [],
    provenance: {
      command: provenance.command,
      exit_code: provenance.exit_code,
      head_commit: ctx.headCommit,
      base_commit: ctx.baseCommit,
      started_at: provenance.started_at,
      ended_at: provenance.ended_at,
      env_digest: ctx.envDigest,
      seed: provenance.seed ?? null,
      // Genesis ran it. A collector cannot claim otherwise — evidence the
      // executor produced enters through a different path and is inadmissible.
      produced_by: provenance.produced_by ?? "genesis",
    },
    artifact_digest: args.artifactDigest ?? null,
  };
}

/** An envelope for a collector that could not run at all. */
export function errorEvidence(
  target: CollectionTarget,
  ctx: CollectorContext,
  collectorName: string,
  message: string,
  command: readonly string[] = [],
): Evidence {
  const now = new Date().toISOString();
  return buildEvidence({
    target,
    ctx,
    collectorName,
    collectorVersion: "unknown",
    adapterVersion: "0.1.0",
    status: "error",
    observation: {},
    detail: [message],
    provenance: { command, exit_code: null, started_at: now, ended_at: now },
  });
}

/** Read a string field from a requirement's config. */
export function configString(req: Requirement, key: string): string | undefined {
  const value = req.config[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a command array from a requirement's config. */
export function configCommand(req: Requirement, key = "command"): string[] | undefined {
  const value = req.config[key];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  return undefined;
}

export function configNumber(req: Requirement, key: string): number | undefined {
  const value = req.config[key];
  return typeof value === "number" ? value : undefined;
}
