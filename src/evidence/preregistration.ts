/**
 * Establishing whether the contract actually came first.
 *
 * This is the impure half of the pre-registration rule. It reads git history
 * and produces plain facts; the Adjudicator consumes those facts and stays
 * pure. The facts are recorded in the ledger with the verdict, so a later
 * replay can see what was known at the time.
 *
 * Note the default when history is unreadable: `determined: false`, which the
 * Adjudicator turns into HUMAN REVIEW. Genesis will not certify a contract it
 * cannot prove came first.
 */

import type { PreRegistrationFacts } from "../adjudicator/index.js";
import type { FrozenContract } from "../contract/schema.js";
import { firstCommitDate, isAncestor, isGitRepo, resolveRef } from "./git.js";

export function checkPreRegistration(
  repoPath: string,
  contract: FrozenContract,
  headCommit: string,
): PreRegistrationFacts {
  const undetermined: PreRegistrationFacts = {
    determined: false,
    base_is_ancestor: false,
    frozen_before_first_commit: false,
    amended_after_first_commit: false,
  };

  if (!isGitRepo(repoPath)) return undetermined;

  const base = resolveRef(repoPath, contract.repo.base_commit);
  const head = resolveRef(repoPath, headCommit);
  if (!base || !head) return undetermined;

  const ancestor = isAncestor(repoPath, base, head);
  if (ancestor === null) return undetermined;

  const firstCommit = firstCommitDate(repoPath, base, head);

  // No commits between base and head: nothing was implemented yet, so the
  // contract trivially predates the work.
  const createdAt = Date.parse(contract.created_at);
  if (!Number.isFinite(createdAt)) return undetermined;

  let frozenBefore = true;
  let amendedAfter = false;

  if (firstCommit !== null) {
    const firstAt = Date.parse(firstCommit);
    if (!Number.isFinite(firstAt)) return undetermined;

    frozenBefore = createdAt <= firstAt;

    if (contract.amendment) {
      const amendedAt = Date.parse(contract.amendment.at);
      if (!Number.isFinite(amendedAt)) return undetermined;
      amendedAfter = amendedAt > firstAt;
    }
  }

  return {
    determined: true,
    base_is_ancestor: ancestor,
    frozen_before_first_commit: frozenBefore,
    amended_after_first_commit: amendedAfter,
  };
}
