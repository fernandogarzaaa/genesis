/**
 * Collection orchestration.
 *
 * Groups a contract's requirements by collector, runs each collector once with
 * everything addressed to it, and returns a materialized `Evidence[]`.
 *
 * The result is handed to the Adjudicator by direct call, not published on the
 * event bus. v1's bus declared itself the only legal inter-component channel,
 * but it retries handlers three times, sorts delivery by registration priority,
 * and silently dead-letters what it cannot deliver. A verdict computed
 * downstream of those behaviors is not reproducible — and reproducibility is
 * the property the whole architecture exists to provide. The bus survives for
 * progress events; it does not carry evidence.
 */

import { randomUUID } from "node:crypto";
import type { FrozenContract } from "../contract/schema.js";
import { allRequirements } from "../contract/schema.js";
import type { Evidence } from "./envelope.js";
import { errorEvidence, type CollectionTarget, type CollectorContext, type CollectorRegistry } from "./registry.js";

export interface CollectionEvents {
  onCollectorStart?(name: string, requirements: number): void;
  onCollectorFinish?(name: string, produced: number, ms: number): void;
  onCollectorError?(name: string, error: Error): void;
}

export async function collectEvidence(
  contract: FrozenContract,
  registry: CollectorRegistry,
  ctx: CollectorContext,
  events: CollectionEvents = {},
): Promise<Evidence[]> {
  const byCollector = new Map<string, CollectionTarget[]>();

  for (const target of allRequirements(contract)) {
    const list = byCollector.get(target.requirement.collector);
    if (list) list.push(target);
    else byCollector.set(target.requirement.collector, [target]);
  }

  const evidence: Evidence[] = [];

  // Sorted so a run's collector order is stable — the Adjudicator re-sorts
  // anyway, but a stable order makes progress output and logs comparable
  // between runs.
  for (const name of [...byCollector.keys()].sort()) {
    const targets = byCollector.get(name) ?? [];
    const collector = registry.get(name);

    if (!collector) {
      for (const target of targets) {
        evidence.push(errorEvidence(target, ctx, name, `no collector named "${name}" is registered`));
      }
      continue;
    }

    events.onCollectorStart?.(name, targets.length);
    const started = Date.now();

    try {
      const produced = await collector.collect(targets, ctx);
      evidence.push(...produced);

      // A collector that silently drops a requirement would leave it with no
      // evidence at all, which the Adjudicator reads as unproven. That is the
      // safe direction, but saying so explicitly is better than an absence.
      const answered = new Set(produced.map((e) => e.requirement_id));
      for (const target of targets) {
        if (!answered.has(target.requirement.id)) {
          evidence.push(
            errorEvidence(target, ctx, name, `collector "${name}" returned no evidence for this requirement`),
          );
        }
      }

      events.onCollectorFinish?.(name, produced.length, Date.now() - started);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      events.onCollectorError?.(name, err);
      for (const target of targets) {
        evidence.push(errorEvidence(target, ctx, name, `collector threw: ${err.message}`));
      }
    }
  }

  return evidence;
}

/** Build a collector context. `idSeed` makes evidence ids deterministic in tests. */
export function makeContext(params: {
  repoPath: string;
  contractHash: string;
  headCommit: string;
  baseCommit: string;
  envDigest: string;
  runner: CollectorContext["runner"];
  putArtifact: CollectorContext["putArtifact"];
  idSeed?: string;
}): CollectorContext {
  let counter = 0;
  const nextId = params.idSeed
    ? () => `${params.idSeed}-${String(++counter).padStart(4, "0")}`
    : () => randomUUID();

  return {
    repoPath: params.repoPath,
    contractHash: params.contractHash,
    headCommit: params.headCommit,
    baseCommit: params.baseCommit,
    envDigest: params.envDigest,
    runner: params.runner,
    putArtifact: params.putArtifact,
    nextId,
  };
}
