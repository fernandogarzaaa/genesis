# Genesis

**The acceptance layer for machine-authored work.**

> Claude Code decides what to do next. Genesis decides whether what was done is
> acceptable, with evidence, and refuses to stop until it is.

---

## Status: v2 spine implemented, uncalibrated

Genesis began as a cognitive operating system for autonomous agents (kernel,
event bus, AXIOM/EVE/ADAM subsystems, React command center). That execution and
orchestration layer is not defensible territory — Claude Code, Codex, LangGraph,
Temporal, OpenRouter and LiteLLM already occupy agent execution, workflow
orchestration, model routing and tool calling. It has been archived at tag
`v1-kernel-archive`.

The problem that remains unsolved is the one *after* execution: an agent can
generate code, but it cannot reliably establish that the implementation is
complete, that it satisfies the original intent, that it is safe to merge, or
what evidence proves any of that. A human currently supplies that step.

**What works today:** contracts can be validated, frozen, and hash-chained into
an immutable ledger; evidence can be collected from six mechanical sources and
from EVE; verdicts are rendered by a pure adjudicator and recorded; outcomes can
be labelled and replayed through the backtest. Genesis passes its own contract.

**What is not yet known:** whether the verdicts correspond to reality. That is
the M4 backtest, and it is the only question that matters. Nothing here should
be described as validated until it has a number attached.

```bash
npm install && npm run build

genesis contract init   --objective @issue.md --repo .
genesis contract freeze --contract contract.json     # before implementation
# … an agent does the work …
genesis verify          --contract contract.json --repo .
```

## Documents

| | |
|---|---|
| [`docs/v2/00-AUDIT.md`](docs/v2/00-AUDIT.md) | What survived the pivot, what was deleted, and why. Includes the audit of the three sibling repositories. |
| [`docs/v2/01-ARCHITECTURE.md`](docs/v2/01-ARCHITECTURE.md) | Genesis v2: Contract Compiler, Evidence Collector, Adjudicator, Ledger. |
| [`docs/v2/02-MIGRATION.md`](docs/v2/02-MIGRATION.md) | Phased plan from the v1 kernel to the v2 CLI. |
| [`docs/v2/03-ROADMAP.md`](docs/v2/03-ROADMAP.md) | Six milestones to the backtest. |
| [`docs/v2/04-RISKS.md`](docs/v2/04-RISKS.md) | Technical risks, ordered by severity. |
| [`docs/v2/05-IMPLEMENTATION-NOTES.md`](docs/v2/05-IMPLEMENTATION-NOTES.md) | Where building it changed the design. |

## The thesis in four points

**1. Genesis is neutral.** The executor cannot grade itself. An external agent
writes the code; Genesis evaluates it independently. The trust comes from the
separation, and the separation is enforced at the data layer — evidence the
executor produced is inadmissible.

**2. Verdicts are evidence-based, not model opinion.** Mechanical evidence
(tests, types, lint, coverage, security scans) is deterministic and binding.
Behavioral evidence (seeded [EVE](https://github.com/fernandogarzaaa/experience-validation-engine)
sessions, reproducible scenarios) is binding. LLM judgment is permitted only for
"does this diff satisfy the stated intent," must cite artifact digests, and can
never override a mechanical failure — or produce a verdict on its own.

**3. Contracts are pre-registered.** The acceptance contract is written, hashed,
timestamped and bound to a base commit *before* the agent touches the repository.
No grading against goalposts that moved. Amendments are permitted, recorded, and
cap the verdict at `HUMAN REVIEW`.

**4. The ledger is the asset.** Every contract, evidence record, and verdict is
appended to a hash-chained ledger, and later joined with what actually happened —
merged clean, reverted, hotfixed, rejected. That record is what makes calibration
possible, and it is the part a competitor cannot clone by reading this page.

## The first product

A CLI. Not a dashboard.

```
$ genesis verify --repo ./project --contract contract.json

VERDICT: NOT READY
Contract 2121df4285e2 (pre_registered, frozen 2026-08-06T09:00:00Z, base 0fcbd4c3)
Evaluated 4 criteria against 4 evidence record(s) at e77b09a4 · adjudicator 0.1.0

FAILED (1)

  AUTH-001  The authentication endpoint rejects invalid credentials.
    ✗ test · expected status 401, received 200
        artifact 186388ab3dc5512a
    ✓ semgrep · 0 critical findings

exit 1
```

Every criterion is falsifiable. Every line traces to an artifact digest that can
be retrieved from the ledger. Exit codes are distinct — `0` SHIP, `1` NOT READY,
`2` HUMAN REVIEW, `3` Genesis itself failed — so CI can block on one and route
the other without parsing stdout.

### The properties that make it an acceptance layer rather than a code reviewer

- **The verdict is a pure function** of (frozen contract, admissible evidence).
  No clock, no network, no randomness. Enforced by an import-boundary test that
  fails if the adjudicator reaches for any of them.
- **Collectors report observations, never pass/fail.** The frozen contract holds
  the expectation and the adjudicator applies it, so replaying stored evidence
  against an amended threshold yields a different verdict — which is exactly
  what calibration needs.
- **Evidence the executor produced is inadmissible.** Recorded in the ledger,
  excluded from the verdict.
- **Missing evidence can never yield SHIP.** A gate that opens when it fails is
  not a gate.
- **Removing the LLM tier can never loosen a verdict.** Tested as a
  monotonicity property, not asserted in a README.

## The first milestone

Not a demo. A backtest: 30 merged PRs, 30 reverted or hotfixed PRs, one
question — *how often did Genesis agree with reality?* — and one number that
matters, the rate at which it said SHIP to something that later broke.

## Related

- **[EVE](https://github.com/fernandogarzaaa/experience-validation-engine)** —
  Experience Validation Engine. Genesis's behavioral evidence producer, consumed
  across a process boundary and deliberately kept separate. EVE produces
  evidence; Genesis renders the acceptance decision.
- **[ADAM](https://github.com/fernandogarzaaa/adam)** — self-evolving organism
  runtime. Source of the hash-linked version chain and single-choke-point
  governance patterns the v2 ledger adopts.
- **[AXIOM-AETHER](https://github.com/fernandogarzaaa/axiom-aether)** —
  local-first TTT and compression runtime. Prior art for calibrated trust gates.

## Long-term positioning

Not "AI workflow automation" — crowded. Not "AI code reviewer" — too weak.

Audit infrastructure for machine-generated work: the same category as financial
auditing, security certification, and compliance verification. It starts as a CI
gate and ends as trust infrastructure for autonomous software creation.
