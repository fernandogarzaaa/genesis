# Genesis v2 — Architecture Proposal

> Claude Code decides what to do next. Genesis decides whether what was done is
> acceptable, with evidence, and refuses to stop until it is.

Status: **proposal**. Nothing in this document is implemented.
Companion documents: `00-AUDIT.md`, `02-MIGRATION.md`, `03-ROADMAP.md`,
`04-RISKS.md`.

---

## 1. The shape of the system

Genesis is a pipeline with a hard boundary through the middle. On one side,
things that gather facts about a repository. On the other, one pure function
that turns facts into a verdict. The boundary is the product.

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  BEFORE ANY CODE IS WRITTEN                                        │
  │                                                                    │
  │   objective ──► Contract Compiler ──► Acceptance Contract          │
  │   (issue/spec)                          │                          │
  │                                         │ canonicalize → SHA-256   │
  │                                         │ bind to base_commit      │
  │                                         ▼                          │
  │                                    ╔═══════════╗                   │
  │                                    ║  LEDGER   ║ ◄── hash-chained  │
  │                                    ╚═══════════╝     append-only   │
  └────────────────────────────────────────────────────────────────────┘
                                             │  contract_hash frozen
    ┌────────────────────────────────────────┼───────────────────────┐
    │  EXTERNAL AGENT EXECUTES  (Claude Code, Codex, a human)        │
    │  Genesis does not participate, observe, assist, or advise.     │
    └────────────────────────────────────────┼───────────────────────┘
                                             ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  EVIDENCE COLLECTOR            (impure, parallel, may fail)        │
  │                                                                    │
  │   mechanical      behavioral            judgmental                 │
  │   ──────────      ──────────            ──────────                 │
  │   tests           EVE sessions (seeded) LLM intent-match           │
  │   typecheck       workflow replay       must cite artifact digests │
  │   lint            state transitions                                │
  │   coverage Δ                                                       │
  │   security scan                                                    │
  │   diff analysis                                                    │
  │        │               │                      │                    │
  │        └───────────────┴──────────────────────┘                    │
  │                        ▼                                           │
  │              Evidence Envelopes (provenance + artifact digest)     │
  └────────────────────────┬───────────────────────────────────────────┘
                           │  admissibility filter
                           ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │  ADJUDICATOR            pure · deterministic · no I/O · no network │
  │                                                                    │
  │   verdict = f(frozen_contract, admissible_evidence)                │
  │                                                                    │
  │        SHIP        NOT READY        HUMAN REVIEW                   │
  └────────────────────────┬───────────────────────────────────────────┘
                           ▼
                    ╔═══════════╗
                    ║  LEDGER   ║  contract · evidence · verdict
                    ╚═══════════╝            ▲
                                             │  later, out of band
                                    outcome label:
                                    merged_clean | reverted | hotfixed | rejected
```

Four components, one of which is pure. The three impure ones can be replaced,
extended, or bought. The pure one is the moat's foundation — and the ledger it
writes to is the moat.

---

## 2. Contract Compiler

### 2.1 What a contract is

A contract is a frozen, content-addressed statement of *what would prove this
objective was met*, created before the work begins and bound to the commit the
work starts from.

```jsonc
{
  "schema_version": "1.0.0",
  "contract_id": "0193f2a1-...",           // uuidv7, sortable, not part of hash input
  "objective": "Harden the authentication endpoint against credential stuffing",

  "repo": {
    "remote": "git@github.com:acme/api.git",
    "base_commit": "a3f91c2e8d..."          // the tree the agent starts from
  },

  "created_at": "2026-08-06T14:22:09.417Z",
  "compiler": { "name": "genesis-contract-compiler", "version": "0.1.0",
                "mode": "assisted" },       // assisted | manual

  "criteria": [
    {
      "id": "AUTH-001",
      "statement": "The authentication endpoint rejects invalid credentials.",
      "binding": true,
      "failure_condition": "Any request with invalid credentials receives a 2xx response.",
      "evidence_requirements": [
        { "kind": "mechanical", "collector": "test",
          "selector": "tests/integration/auth.spec.ts::rejects invalid credentials",
          "expect": { "status": "pass" } },
        { "kind": "mechanical", "collector": "http-probe",
          "request": { "method": "POST", "path": "/auth/login",
                       "body": { "user": "probe", "pass": "wrong" } },
          "expect": { "status_code": 401 } },
        { "kind": "mechanical", "collector": "semgrep",
          "expect": { "findings": { "severity": "critical", "max": 0 } } }
      ]
    },
    {
      "id": "AUTH-002",
      "statement": "A locked-out user is told why, and how long, in the UI.",
      "binding": true,
      "failure_condition": "The lockout screen shows a generic error with no reason or duration.",
      "evidence_requirements": [
        { "kind": "behavioral", "collector": "eve",
          "session": { "persona": "first-time-user", "seed": 4711,
                       "goal": "log in after three failed attempts" },
          "expect": { "goal_achieved": false,
                      "findings": { "severity": "critical", "max": 0 } } }
      ]
    }
  ],

  "global_gates": [
    { "id": "COV-001", "binding": true, "collector": "coverage",
      "expect": { "line_pct_delta": { "min": 0.0 } } },
    { "id": "TYPE-001", "binding": true, "collector": "typecheck",
      "expect": { "errors": 0 } }
  ],

  "supersedes": null,                       // prior contract_hash, if an amendment
  "amendment": null                         // { reason, author, at }
}
```

### 2.2 Falsifiability is enforced, not encouraged

`"Users can login securely"` must be rejected by the compiler, not merely
discouraged in the docs. A criterion is admitted only if:

1. It declares at least one `evidence_requirement` naming a registered collector.
2. Each requirement's `expect` is machine-comparable — a value, a bound, or a
   set predicate. Never prose.
3. It declares a `failure_condition` describing an observable state.

The compiler operates in two modes. **`manual`** takes a hand-written contract
and validates it. **`assisted`** takes an issue or spec, and an LLM *drafts*
criteria — but the draft is only a proposal. It must pass the same structural
validation, and the LLM has no ability to weaken it: it cannot mark a criterion
non-binding, cannot author an `expect` that is trivially true (a linter rejects
`{ "min": null }`, empty predicates, and `max: Infinity`), and its output is
presented for human confirmation before freezing. `compiler.mode` is recorded in
the ledger so assisted contracts are always distinguishable in the calibration
data.

### 2.3 Freezing

```
contract_hash = SHA-256( JCS( contract_without_volatile_fields ) )
```

Canonicalization is RFC 8785 (JSON Canonicalization Scheme): sorted keys,
normalized numbers, no insignificant whitespace. `contract_id` and any
`hash`/`signature` field are excluded from hash input. Everything else —
including `created_at` and `base_commit` — is inside the hash.

This is the property ADAM's `content_hash` documents and that a naive
`JSON.stringify` silently lacks: two contracts with identical content hash
identically regardless of key insertion order.

Freezing writes a `CONTRACT_REGISTERED` entry to the ledger. From that moment
the contract is immutable in the only sense that matters: any modification
produces a different hash, and the ledger's chain (§4) records which hash was
graded against.

### 2.4 Amendments

Requirements change. Amendment is supported and is never mutation:

```
contract_v2.supersedes = contract_v1.hash
contract_v2.amendment  = { reason: "...", author: "fernando", at: "..." }
```

A new hash, a new `CONTRACT_AMENDED` ledger entry, the full chain retained.
The Adjudicator records which hash it graded, so "the contract was loosened
after the tests failed" is always visible in the ledger rather than inferable.

**Amendments are not free.** An amendment landing after the first commit in the
diff downgrades the verdict ceiling to `HUMAN REVIEW` (§5.3). Genesis will not
say SHIP against a goalpost that moved mid-flight.

---

## 3. Evidence Collector

### 3.1 One envelope for everything

The Adjudicator must not know or care where a fact came from. Every collector,
mechanical or judgmental, emits the same shape:

```jsonc
{
  "evidence_id": "0193f2b7-...",
  "contract_hash": "9c1f...",              // what this was gathered against
  "criterion_ids": ["AUTH-001"],
  "kind": "mechanical",                     // mechanical | behavioral | judgmental
  "collector": { "name": "vitest", "version": "4.1.10", "adapter_version": "0.1.0" },

  "status": "fail",                         // pass | fail | error | not_run
  "observation": {                          // structured, collector-specific
    "test": "rejects invalid credentials",
    "expected_status_code": 401,
    "received_status_code": 200
  },

  "provenance": {
    "command": ["npx", "vitest", "run", "tests/integration/auth.spec.ts"],
    "exit_code": 1,
    "head_commit": "e77b09a4...",
    "base_commit": "a3f91c2e...",
    "started_at": "2026-08-06T14:41:02.113Z",
    "ended_at":   "2026-08-06T14:41:19.882Z",
    "env_digest": "sha256:6b1d...",         // node version, lockfile, OS, container image
    "seed": null,                            // required when the collector is stochastic
    "produced_by": "genesis"                 // genesis | attested_ci | executor
  },

  "artifact_digest": "sha256:2f7c...",       // digest of the raw log/report, stored as a blob
  "artifact_ref": "blob:2f7c..."
}
```

`provenance` is what makes this evidence rather than an assertion. A verdict is
only as auditable as its ability to answer *"prove it"* — and the answer is:
this command, this exit code, this commit, this environment, this artifact,
whose digest matches.

### 3.2 Admissibility — the neutrality principle, mechanized

> *The executor cannot grade itself.*

That principle is decorative unless it is enforced at the data layer. Genesis
therefore admits evidence from exactly two sources:

1. **`produced_by: "genesis"`** — Genesis ran the command itself, in a sandbox
   it controlled, and holds the artifact.
2. **`produced_by: "attested_ci"`** — fetched directly from a CI provider's API
   over an authenticated channel (GitHub Checks, etc.), where the provider —
   not the agent — vouches for the result.

Everything else is **inadmissible**. Specifically: a `test-results.json` file
committed into the diff is not evidence. A summary the agent writes in the PR
body is not evidence. `provenance.produced_by: "executor"` is recorded in the
ledger for completeness and excluded from adjudication.

This rule is small and easy to skip. It is also the difference between an
independent acceptance layer and an elaborate way of asking the agent whether
it is finished.

### 3.3 "Genesis does not execute" — the precise meaning

The thesis says Genesis observes and evaluates rather than executes. But running
a test suite *is* running code, and there is no evidence-based verifier that
doesn't. The distinction that actually holds:

- Genesis **never authors, modifies, or repairs** anything in the repository.
  It has no write path to the working tree.
- Genesis **does execute the repository's own declared verification commands**,
  in a sandbox, to observe their results firsthand.
- The commands available are declared in the contract and in
  `genesis.config.json` — Genesis does not invent commands, and does not run
  commands the agent introduced in the diff without flagging them (§3.6 of
  `04-RISKS.md`).

Sandbox posture for MVP: subprocess with a scrubbed environment, no inherited
credentials, a wall-clock timeout, and a working copy checked out fresh at
`head_commit`. Container isolation is a Phase-2 hardening item, not a Day-1
blocker for a locally-run CLI.

### 3.4 Collectors, and why they are not on the event bus

Collectors are impure: they spawn processes, hit networks, and time out. They
run concurrently, and their progress should stream to the terminal. The v1
event bus (`kernel/events/event-bus.ts`) is a good fit for exactly that, and it
survives the pivot for exactly that.

It does **not** carry evidence into the Adjudicator. The v1 header declares the
bus the only legal channel between components; v2 explicitly overrides that
rule, because the bus retries handlers up to three times, sorts delivery by
registration priority, and silently dead-letters what it cannot deliver. A
verdict computed downstream of those behaviors is not reproducible, and
reproducibility is the property the whole architecture exists to provide.

So: the collector phase completes, returns a materialized `Evidence[]`, and the
Adjudicator is called directly with it. The bus emits `collector.started`,
`collector.progress`, `collector.finished` for the UI and the logs, and nothing
downstream of adjudication reads them.

### 3.5 The three tiers

**Mechanical** — deterministic, binding. Test runner, typecheck, lint, coverage
delta, security scan, diff analysis (files touched, LOC, blast radius, whether
migrations or auth paths were modified). Adapters normalize each tool's native
output; each adapter is small and independently testable against recorded
fixtures.

**Behavioral** — reproducible under seed, binding. The MVP's sole behavioral
collector is EVE, invoked across the process boundary:

```
eve run <url> --persona first-time-user --seed 4711 --goal "..." --json
```

`SessionResult` maps cleanly onto the envelope: `seed` → `provenance.seed`,
`findings[]` (which already carry `evidence: string[]`) → `observation`,
`goalAchieved` / `abandoned` / `abandonReason` → `status`. `eve_compare_builds`
supports behavioral regression between `base_commit` and `head_commit` directly.
The adapter is roughly 150 lines and EVE is not modified. Its determinism
guarantee — *"given the same seed, persona and application state, EVE takes the
same path"* — is what makes behavioral evidence admissible at all.

**Judgmental** — non-binding, and structurally incapable of being terminal.
An LLM answers one narrow question: *does this diff satisfy the stated intent
of criterion X?* Constraints:

- It receives the criterion, the diff, and the mechanical/behavioral evidence
  already gathered. It does not receive the desired answer.
- Its output must cite `artifact_digest` values it was shown. An uncited claim
  is dropped by the adapter, not passed through with a caveat.
- Its envelope is `kind: "judgmental"`, and §5 gives that kind no path to
  `NOT READY` and no path to `SHIP` on its own.
- Model, version, prompt digest, and temperature go in `collector`. A verdict
  influenced by a model that has since changed must be identifiable in the
  calibration data.

---

## 4. Ledger

### 4.1 Hash-chained, append-only

`00-AUDIT.md` §3.1 establishes the gap: v1's `audit_log` is an ordinary table
whose `timestamp` column is supplied by its writer. The ledger is the stated
long-term asset. An asset that can be silently edited is not an audit record,
and a calibration dataset that can be silently edited is not evidence of
calibration.

```sql
CREATE TABLE ledger (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  prev_hash    TEXT NOT NULL,        -- entry_hash of seq-1; genesis block: 64 zeros
  entry_hash   TEXT NOT NULL UNIQUE, -- SHA-256(JCS(entry_without_entry_hash))
  entry_type   TEXT NOT NULL,        -- CONTRACT_REGISTERED | CONTRACT_AMENDED
                                     -- | EVIDENCE_RECORDED  | VERDICT_RENDERED
                                     -- | OUTCOME_LABELED
  contract_hash TEXT,
  payload      TEXT NOT NULL,        -- canonical JSON
  recorded_at  INTEGER NOT NULL
);
CREATE INDEX idx_ledger_contract ON ledger(contract_hash);
CREATE INDEX idx_ledger_type     ON ledger(entry_type, seq);
```

`genesis ledger verify` walks the chain and recomputes every hash. Any edit,
deletion, or reordering breaks it at a specific `seq`, and the command says
where. This does not make tampering impossible — a local SQLite file with a
determined owner never can be — it makes tampering *detectable*, which is the
achievable and sufficient property. Optional Phase-2: periodic anchoring of the
head hash to a signed git tag or an external timestamping service, which
converts detectable into detectable-by-third-parties.

Every write goes through one `LedgerWriter` with no bypass — the choke-point
discipline `adam-governance` documents and v1's freely-callable `AuditLoggerImpl`
lacks.

### 4.2 Outcome labels — the actual asset

A verdict without an outcome is an opinion. The ledger's value accrues from the
join:

```jsonc
// OUTCOME_LABELED, written days or weeks later
{
  "contract_hash": "9c1f...",
  "verdict_entry_hash": "4d2a...",
  "label": "reverted",             // merged_clean | reverted | hotfixed | rejected
  "label_source": "github_webhook", // github_webhook | manual | backfill
  "labeled_at": "2026-08-20T09:14:00Z",
  "detail": { "revert_commit": "b91f...", "days_to_revert": 3 }
}
```

Sources, in order of preference: a GitHub webhook detecting revert commits and
`Fixes #` hotfixes; a manual `genesis label` command; a backfill script over
merged history. Labels are appended, never overwritten — a re-label is a new
entry with `supersedes`, so label churn is itself visible in the data.

This table is what §7 backtests against, and it is the only part of the system a
competitor cannot clone by reading this document.

---

## 5. Adjudicator

### 5.1 The invariant

```ts
function adjudicate(contract: FrozenContract, evidence: Evidence[]): Verdict
```

Pure. No I/O, no clock, no network, no randomness, no filesystem. Given the same
contract hash and the same evidence set, it returns a byte-identical verdict —
today, and in two years when the ledger is replayed to recalibrate.

This is enforced, not asserted: a CI test replays the entire ledger through the
current adjudicator and diffs against recorded verdicts. Determinism is a test
that fails, not a paragraph in a README.

### 5.2 Per-criterion state

For each binding criterion `c`, over the admissible evidence mapped to it:

| Condition | State |
|---|---|
| any `kind ∈ {mechanical, behavioral}` with `status = fail` | **FAILED** |
| a declared `evidence_requirement` has no matching record, or its record is `error` / `not_run` | **UNPROVEN** |
| mechanical + behavioral all `pass`, but a judgmental record says `fail` | **CONTESTED** |
| every declared requirement satisfied with `status = pass` | **SATISFIED** |

`FAILED` is terminal. No judgmental evidence, no confidence score, and no
subsequent collector can move a criterion out of `FAILED`. This is the brief's
"a model can never override a mechanical failure," expressed as a lattice with
no upward edge from `FAILED`.

### 5.3 Verdict

```
if ∃c : FAILED                                      → NOT READY
else if ∃c : UNPROVEN ∨ CONTESTED                   → HUMAN REVIEW
else if pre-registration was violated               → HUMAN REVIEW
else                                                → SHIP
```

Pre-registration is violated when `contract.created_at` is later than the author
timestamp of the earliest commit in `base_commit..head_commit`, or when the
contract was amended after that commit, or when `contract.repo.base_commit` is
not an ancestor of `head_commit`. All three mean the goalposts and the work were
not independent, and Genesis declines to certify that.

Non-binding criteria never affect the verdict. They appear in the report as
advisories and are recorded in the ledger, where they are available to the
calibration analysis — a non-binding signal that turns out to predict reverts is
exactly the kind of finding §7 exists to surface.

### 5.4 Two asymmetries, stated deliberately

**Absence of evidence is never evidence of acceptability.** A collector that
crashed, timed out, or was not configured yields `UNPROVEN`, which yields
`HUMAN REVIEW`. It never yields `SHIP`. Anything else makes Genesis easiest to
satisfy by breaking it, and a gate that opens when it fails is not a gate.

**Judgmental evidence cannot be terminal in either direction.** It cannot force
`NOT READY` (an LLM should not be able to block a merge on prose), and it cannot
complete a `SHIP` on its own (an LLM should not be able to certify one either).
Its only power is to move an otherwise-clean result to `HUMAN REVIEW` via
`CONTESTED` — that is, to raise a hand. This is a stricter reading than the
brief requires; the brief forbids models from overriding mechanical *failures*.
Extending the constraint symmetrically costs little and closes the more likely
long-run failure mode, which is a system that gradually learns to trust its own
narrator.

### 5.5 Output

```
VERDICT: NOT READY
Contract 9c1f8a2e (registered 2026-08-06T14:22:09Z, base a3f91c2e)
Evaluated 8 criteria against 23 evidence records · adjudicator 0.1.0

FAILED (2)

  AUTH-001  The authentication endpoint rejects invalid credentials.
    ✗ vitest 4.1.10 · tests/integration/auth.spec.ts::rejects invalid credentials
        expected status 401, received 200
        exit 1 · e77b09a4 · sha256:2f7c8b91
    ✓ semgrep 1.88.0 · 0 critical findings

  COV-001   Line coverage must not decrease.
    ✗ c8 · 82.4% → 71.1%  (delta -11.3pp, floor 0.0pp)
        exit 0 · e77b09a4 · sha256:9a01c4de

SATISFIED (5)   AUTH-003, AUTH-004, TYPE-001, LINT-001, SEC-002
UNPROVEN  (1)
  AUTH-002  A locked-out user is told why, and how long, in the UI.
    ! eve 0.3.1 · collector error: no reachable URL configured
        (unproven criteria cannot yield SHIP)

SUGGESTED REMEDIATION
  1. AUTH-001 — the middleware returns 200 on the invalid-credential path.
  2. COV-001  — 11.3pp of coverage was lost; 4 new files carry no tests.
  3. AUTH-002 — configure a preview URL so the behavioral check can run.

Ledger: entry 4d2a7f13 · chain verified through seq 1,284
```

Every line traces to an artifact digest. The remediation section is advisory
prose and is labeled as such — it is the one place judgment appears in the
output, and it has no bearing on the verdict above it.

---

## 6. CLI

```
genesis contract init   --objective <file|-> --repo . --out contract.json
genesis contract freeze --contract contract.json          # → ledger, prints hash
genesis contract amend  --contract contract.json --reason "..."

genesis verify   --repo . --contract contract.json [--head HEAD] [--json]
                 # exit 0 = SHIP · 1 = NOT READY · 2 = HUMAN REVIEW · 3 = internal error

genesis label    --contract <hash> --outcome reverted [--detail ...]

genesis ledger   verify | export --format jsonl | show <hash>

genesis backtest --dataset prs.jsonl --report backtest.html
```

Distinct exit codes for `NOT READY` and `HUMAN REVIEW` matter: a CI integration
must be able to block on the first and route to a human on the second without
parsing stdout. Exit 3 is reserved for Genesis itself failing, which must never
be confusable with a repository failing.

---

## 7. Calibration and the backtest

The moat is not the verifier — it is the record of which evidence predicted
which outcome. That record only exists if the backtest is designed before the
verifier ships.

### 7.1 Contract provenance is segregated, always

Historical PRs cannot have pre-registered contracts; their contracts are
reconstructed from the issue and the merged diff. A reconstructed contract has
seen the answer, so its criteria are optimistically shaped no matter how careful
the reconstruction.

Every contract therefore carries `provenance: pre_registered | reconstructed`,
and **the two are never pooled in a reported metric.** Reconstructed contracts
measure whether the evidence pipeline discriminates. Only pre-registered
contracts measure whether Genesis works. Conflating them would produce a
headline number that is both excellent and meaningless, and it is the single
easiest way for this project to fool itself.

### 7.2 Metrics — not "accuracy"

The 30-merged / 30-reverted design is a balanced sample; real repositories revert
2-5% of PRs. Accuracy on a balanced sample says nothing about precision in
production, and the costs are wildly asymmetric. Report:

| Metric | Definition | Why |
|---|---|---|
| **False-ship rate** | `P(SHIP \| reverted ∨ hotfixed)` | The number that matters. A false SHIP is the only failure that destroys trust permanently. Target: ~0. |
| **Block rate on good work** | `P(NOT READY \| merged_clean)` | The adoption cost. A gate nobody can pass gets disabled. |
| **Coverage** | `P(verdict ≠ HUMAN REVIEW)` | HUMAN REVIEW is safe but has no value if it is the usual answer. |
| **Escalation precision** | `P(reverted \| HUMAN REVIEW)` vs. base rate | Is the hand-raise informative, or noise? |
| **Per-collector lift** | Δ in discrimination when each collector is ablated | Which evidence is load-bearing. Directly guides where to invest. |

Every reported figure carries a Wilson interval. At n=60 these intervals are
wide, and saying so is part of the deliverable — the AXIOM-AETHER trust gate's
conformal treatment (calibrated at δ=0.10 on labeled data) is the right prior
art for how to state coverage claims honestly, and it is already in-house.

### 7.3 What "success" means for the first backtest

Not a high score. The bar is: **zero false SHIPs on the reverted set, with
non-trivial coverage on the merged set.** A system that returns `HUMAN REVIEW`
for everything achieves the first half and fails the second, and the report must
make that visible rather than let it hide inside an accuracy figure.

---

## 8. Repository layout

```
genesis/
├── src/
│   ├── contract/      compiler · JCS canonicalization · freeze · amend · validate
│   ├── evidence/      envelope types · admissibility · collector registry
│   │   ├── mechanical/  test · typecheck · lint · coverage · security · diff
│   │   ├── behavioral/  eve-adapter
│   │   └── judgmental/  llm-judge (single provider, thin)
│   ├── adjudicator/   PURE — imports only contract/ + evidence/ types
│   ├── ledger/        hash chain · writer choke point · verify · export
│   ├── observability/ event bus (from v1) · progress · logging
│   └── cli/           verify · contract · label · ledger · backtest
├── docs/v2/
└── fixtures/          recorded collector outputs for adapter tests
```

A boundary test asserts that `src/adjudicator/**` imports nothing from
`src/evidence/mechanical|behavioral|judgmental`, `src/ledger`, `src/cli`, or any
Node built-in. Purity enforced by a failing test, not by a convention.

Single package, not a monorepo — at this size workspaces cost more than the
boundary they buy, and the import test provides the boundary directly.

---

## 9. What Genesis deliberately is not

- **Not an executor.** No write path to the working tree.
- **Not a model router.** One LLM call site, one provider interface, no tiers,
  no cost-optimizing policy. v1's `ProviderRegistry` is deleted.
- **Not a workflow engine.** No DAG, no retries-with-compensation, no
  orchestration. Temporal and LangGraph own that.
- **Not an AI code reviewer.** A reviewer offers opinions. Genesis renders a
  verdict that is reproducible from a ledger and reducible to artifact digests.
  If the LLM were removed entirely, Genesis would still work — it would only
  return `HUMAN REVIEW` more often. No AI code reviewer survives that test, and
  that is the whole distinction.
- **Not a dashboard.** Not in the MVP, and not until the CLI's verdicts have
  been backtested.
