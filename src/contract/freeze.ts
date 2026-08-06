/**
 * Freezing and amending contracts.
 *
 * Freezing is what makes pre-registration meaningful: after it, any change to
 * the contract produces a different hash, and the ledger records which hash a
 * verdict was rendered against. "The goalposts moved after the tests failed" is
 * therefore visible in the record rather than inferable from it.
 */

import { randomUUID } from "node:crypto";
import { hashCanonicalExcluding } from "../shared/canonical.js";
import {
  CONTRACT_HASH_EXCLUDED,
  SCHEMA_VERSION,
  type Amendment,
  type Contract,
  type FrozenContract,
} from "./schema.js";

/**
 * Assign stable requirement ids.
 *
 * Ids are derived from position and baked into the contract *before* hashing,
 * so evidence can reference a requirement by id forever. Author-supplied ids
 * are preserved.
 */
export function normalizeContract(contract: Contract): Contract {
  return {
    ...contract,
    criteria: contract.criteria.map((criterion) => ({
      ...criterion,
      evidence_requirements: criterion.evidence_requirements.map((requirement, i) => ({
        ...requirement,
        id: requirement.id || `${criterion.id}#${i}`,
      })),
    })),
  };
}

/** Compute a contract's content hash. Excludes identity and the digest itself. */
export function computeContractHash(contract: Contract): string {
  return hashCanonicalExcluding(
    contract as unknown as Record<string, unknown>,
    CONTRACT_HASH_EXCLUDED,
  );
}

/** Normalize, hash, and return an immutable frozen contract. */
export function freezeContract(contract: Contract): FrozenContract {
  const normalized = normalizeContract(contract);
  const contract_hash = computeContractHash(normalized);
  return Object.freeze({ ...normalized, contract_hash });
}

/** Re-derive the hash and check it matches what the contract claims. */
export function verifyContractHash(contract: FrozenContract): boolean {
  return computeContractHash(contract) === contract.contract_hash;
}

/**
 * Produce an amended contract that supersedes `prior`.
 *
 * Amendment is never mutation: the prior contract keeps its hash and its ledger
 * entry, and the amended contract points back at it. The adjudicator penalizes
 * amendments that land after implementation began (see `adjudicator/`), so the
 * cost of moving a goalpost is paid in the verdict rather than hidden.
 */
export function amendContract(
  prior: FrozenContract,
  changes: Partial<Omit<Contract, "supersedes" | "amendment" | "schema_version">>,
  amendment: Amendment,
): FrozenContract {
  // Destructure `contract_hash` off rather than carrying it forward: the prior
  // digest must not leak into the new record's content before rehashing.
  const { contract_hash: _priorHash, ...withoutHash } = prior;

  const next: Contract = {
    ...withoutHash,
    ...changes,
    schema_version: SCHEMA_VERSION,
    contract_id: randomUUID(),
    supersedes: prior.contract_hash,
    amendment,
  };
  return freezeContract(next);
}

/** Scaffold an unfrozen contract for a human to fill in. */
export function draftContract(params: {
  objective: string;
  baseCommit: string;
  remote?: string;
  provenance?: Contract["provenance"];
  now?: string;
}): Contract {
  return {
    schema_version: SCHEMA_VERSION,
    contract_id: randomUUID(),
    objective: params.objective,
    provenance: params.provenance ?? "pre_registered",
    repo: { remote: params.remote ?? "", base_commit: params.baseCommit },
    created_at: params.now ?? new Date().toISOString(),
    compiler: { name: "genesis-contract-compiler", version: "0.1.0", mode: "manual" },
    criteria: [
      {
        id: "EXAMPLE-001",
        statement: "Replace this with one falsifiable claim about the finished work.",
        binding: true,
        failure_condition: "Describe the observable state that would mean this is not met.",
        evidence_requirements: [
          {
            id: "EXAMPLE-001#0",
            kind: "mechanical",
            collector: "test",
            config: { command: ["npm", "test"] },
            expect: [{ metric: "failed", op: "equals", value: 0 }],
          },
        ],
      },
    ],
    supersedes: null,
    amendment: null,
  };
}
