# Implementation Notes

What building the v2 spine changed about the design in `01-ARCHITECTURE.md`.

The architecture proposal was written from reading the v1 code. These are the
places where writing the v2 code produced a different answer, plus the design
decisions that only became concrete once there was something to run.

---

## 1. The event bus was deleted, not demoted

`00-AUDIT.md` §2.1 recommended keeping the event bus and demoting it from
architecture to observability. Building the pipeline showed it has no consumer.

Collector progress is carried by a five-line callback interface
(`CollectionEvents` in `src/evidence/collect.ts`) that the CLI implements
directly. That covers every use the demoted bus was being kept for. Retaining
363 lines of wildcard-matching, dead-lettering, priority-sorted delivery to
serve three optional callbacks would have been keeping a component because the
plan said to, not because anything needed it.

The reasoning against the bus in the adjudication path stands unchanged and is
now enforced by a test rather than a doctrine: `collectEvidence` returns a
materialized `Evidence[]` and `adjudicate` is called directly.

The v1 bus is in git history at tag `v1-kernel-archive`. Its DLQ bug — the
fabricated retry history described in `02-MIGRATION.md` — went with it.

## 2. Collectors report observations; the Adjudicator decides pass/fail

The proposal had collectors emitting `status: pass | fail`. That was wrong, and
the mistake is the same species the whole project exists to prevent: it puts
acceptance policy in two places.

In the built system a collector reports only whether *collection* succeeded
(`collected | flaky | error | not_run`) plus a map of what it observed. The
frozen contract holds the expectation, and the Adjudicator applies it.

Three things fall out of this that the original shape could not provide:

- **One place decides.** A collector cannot be tuned into leniency, because it
  has no opinion to tune.
- **Replay becomes meaningful.** Re-adjudicating stored evidence against an
  amended threshold yields a different verdict. That is precisely the operation
  calibration needs, and it is impossible if the pass/fail was baked in at
  collection time.
- **"Undecidable" stays distinct from "failed."** `evaluateExpectation` returns
  `undecidable` when the observation lacks the metric, which becomes UNPROVEN
  rather than FAILED. Collapsing the two would let a broken collector read as a
  broken repository.

## 3. Judgmental evidence: a monotonicity property, not a rule list

`01-ARCHITECTURE.md` §5.4 said judgmental evidence cannot be terminal in either
direction. Implementing it surfaced a case the prose did not cover: what happens
when a contract *declares* a judgmental requirement and the collector does not
run?

The first implementation ignored it, and the test caught the consequence —
turning the judgmental collector off moved a verdict from HUMAN REVIEW to SHIP.
That is exactly backwards: it makes the LLM load-bearing for *strictness*, so
disabling it weakens the gate.

The rule is now stated as a property and tested as one:

> Removing judgmental evidence must never make the verdict more permissive.

`tests/adjudicator.test.ts` ranks `NOT_READY < HUMAN_REVIEW < SHIP` and asserts
the inequality across every combination of mechanical and judgmental outcome.
An unproven judgmental requirement now leaves its criterion UNPROVEN.

This is a better formulation than the original prose because it survives cases
nobody enumerated in advance.

## 4. Purity is enforced against imports, not just against globals

`tests/adjudicator.purity.test.ts` failed on the first run, against
`src/adjudicator/index.ts` importing `sortEvidence` from `../evidence/envelope.js`.

The function is pure and the import was harmless. The test was still right: it
is a runtime dependency from the pure core on a module outside it, and that is
the crack that widens. The sort is now eight inlined lines and the pure core
imports nothing but types and its own sibling.

Writing this test before the LLM tier exists was the point. It cost nothing
today and would have been contentious once something needed the exemption.

## 5. Canonicalization rejects rather than coerces

`JSON.stringify` turns `NaN` into `null` and silently drops object properties
holding `undefined`. Either would let two structurally different contracts
produce the same digest.

`canonicalize()` throws on non-finite numbers, `undefined`, functions, symbols,
`bigint`, and circular references. It also normalizes `-0` to `0`, since they
are the same JSON number and must not hash differently.

## 6. Contract validation is two-layered, and zod does the outer layer

Zod 4's `z.number()` rejects non-finite values, so a `lte: Infinity` bound —
the most likely way a contract gets quietly weakened — never reaches the custom
predicate checks. The explicit non-finite guard in `checkExpectation` remains as
a backstop for direct callers.

What the custom layer actually adds, and what no schema can express:

- unknown collector names, checked against the live registry
- empty `one_of` sets (unsatisfiable) and non-finite bounds (trivially true)
- contradictory expectations on one metric (`equals 401` and `equals 200`;
  `gte 90` and `lte 50`)
- contracts in which nothing is binding, and so which can never yield NOT READY
- advisories for hedging language and for `failure_condition` restating the
  criterion

## 7. `global_gates` folded into criteria

The proposal had a separate `global_gates` array. A gate is a criterion with a
collector and an expectation, so the separate concept bought a second code path
and nothing else. Repository-level gates are expressed as ordinary criteria.

Contract templates (`04-RISKS.md` R4, mitigation 3) are the better answer to the
problem `global_gates` was reaching for, and they need no schema support.

## 8. Simplifications that stayed simple

- **Single package, not a monorepo.** The import-boundary test provides the
  boundary that workspaces would have enforced, at a fraction of the cost.
- **Coverage delta takes a supplied base summary.** Checking out and building
  the base tree would double every verify run. Where no base summary is given,
  the delta metric is simply absent — and an expectation on it becomes
  undecidable, which yields HUMAN REVIEW rather than a fabricated zero.
- **`util.parseArgs`** instead of a CLI framework. Three runtime dependencies
  total: `better-sqlite3`, `zod`, `uuid`.

---

## What is built

```
src/
  shared/canonical.ts     RFC 8785 JCS + SHA-256
  shared/redact.ts        secret redaction, applied before hashing
  contract/               schema · validate · freeze · amend
  evidence/               envelope · admissibility · registry · runner · git
    mechanical/           command · test · typecheck · lint · coverage · diff
    behavioral/           eve
  adjudicator/            PURE — the verdict function and the expectation DSL
  ledger/                 hash-chained SQLite, one write path
  backtest/               replay + calibration metrics with Wilson intervals
  cli/                    contract · verify · label · ledger · backtest
```

155 tests. Typecheck covers every TypeScript file in the repository — the scope
mismatch that hid v1's broken imports is fixed, and CI runs it.

### Verified end to end

Genesis verifying Genesis, through the built CLI:

```
$ genesis contract freeze --contract self-contract.json
Frozen.
  contract_hash  61ba27dd8b5525f1bf70f21519a32a1f7820dd7edfb4a86175186f03285ee644
  ledger entry   37e93365b20c79e9 (seq 1)

$ genesis verify --contract self-contract.json --repo .
VERDICT: SHIP
  All 3 binding criteria are satisfied by admissible evidence, and the
  contract was frozen before implementation began.
exit 0

$ genesis ledger verify
Chain intact. 14 entries.

# after a direct UPDATE against the SQLite file:
$ genesis ledger verify
CHAIN BROKEN at seq 5
  entry_hash mismatch: stored c4c5f750075e, recomputed b677c7c3d7a9
  — this entry's contents were modified after it was written
exit 3
```

Both failure paths confirmed: a violated expectation yields NOT READY and exit
1, citing `155 >= 100000 is false` against a retrievable artifact digest; an
unregistered contract is refused outright.

---

## What is deliberately not built

- **The judgmental (LLM) collector.** The lattice handles `kind: "judgmental"`
  and the monotonicity property is tested, so the policy ships before the tier
  that needs it. That ordering was the cheap moment to fix it.
- **Container isolation.** The MVP is a locally-run CLI against the user's own
  code. This is a hard prerequisite before hosted verification, per R8.
- **Assisted contract compilation.** `contract init` scaffolds a placeholder a
  human fills in. LLM-drafted criteria are a real ergonomic win (R4) but need
  the human-confirmation flow to be worth anything.
- **GitHub Action and webhook labeling.** `genesis label` exists; automating it
  is M5, after the backtest has validated the verdict logic.
- **Anything from v1**: no planning, execution, routing, autonomous loops,
  provider abstraction, or cognitive subsystems.

## Next

M4 in `03-ROADMAP.md`: assemble 30 merged and 30 reverted pull requests,
reconstruct contracts (flagged `provenance: "reconstructed"`, never pooled with
pre-registered ones), and answer the question that decides whether any of this
works — *does pre-merge evidence discriminate changes that get reverted from
changes that do not?*

The dataset sourcing is still unspecified, and it is now the critical path.
