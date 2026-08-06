/**
 * The default collector set.
 *
 * Adding an evidence producer means registering it here and nothing else — the
 * Adjudicator never learns its name. That is the point of the stable envelope:
 * Genesis does not assume EVE, or any other source, is the only one.
 *
 * Not yet registered: the judgmental (LLM) collector. The adjudication lattice
 * already handles `kind: "judgmental"` — such evidence can escalate a clean
 * result to HUMAN REVIEW but can never satisfy or fail a criterion — so the
 * policy is in place and tested before the tier that needs it exists. That
 * ordering is deliberate: the constraint is trivially satisfiable now and would
 * be contentious to add once the tier is load-bearing.
 */

import { CollectorRegistry } from "./registry.js";
import { commandCollector } from "./mechanical/command.js";
import { coverageCollector } from "./mechanical/coverage.js";
import { diffCollector } from "./mechanical/diff.js";
import { lintCollector } from "./mechanical/lint.js";
import { testCollector } from "./mechanical/test.js";
import { typecheckCollector } from "./mechanical/typecheck.js";
import { eveCollector } from "./behavioral/eve.js";

export function defaultRegistry(): CollectorRegistry {
  return new CollectorRegistry()
    .register(commandCollector)
    .register(testCollector)
    .register(typecheckCollector)
    .register(lintCollector)
    .register(coverageCollector)
    .register(diffCollector)
    .register(eveCollector);
}

export { CollectorRegistry };
