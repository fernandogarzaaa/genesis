# Genesis

**The acceptance layer for machine-authored work.**

> Claude Code decides what to do next. Genesis decides whether what was done is
> acceptable, with evidence, and refuses to stop until it is.

---

## Status: architecture proposal

Genesis is being repositioned. It began as a cognitive operating system for
autonomous agents (kernel, event bus, AXIOM/EVE/ADAM subsystems, React command
center). That execution and orchestration layer is not defensible territory —
Claude Code, Codex, LangGraph, Temporal, OpenRouter and LiteLLM already occupy
agent execution, workflow orchestration, model routing and tool calling.

The problem that remains unsolved is the one *after* execution: an agent can
generate code, but it cannot reliably establish that the implementation is
complete, that it satisfies the original intent, that it is safe to merge, or
what evidence proves any of that. A human currently supplies that step.

**Nothing in `docs/v2/` is implemented yet.** The v1 kernel in this repository
does not currently compile — see `docs/v2/00-AUDIT.md` §1.

## Documents

| | |
|---|---|
| [`docs/v2/00-AUDIT.md`](docs/v2/00-AUDIT.md) | What survives the pivot, what gets deleted, and why. Includes the audit of the three sibling repositories. |
| [`docs/v2/01-ARCHITECTURE.md`](docs/v2/01-ARCHITECTURE.md) | Genesis v2: Contract Compiler, Evidence Collector, Adjudicator, Ledger. |
| [`docs/v2/02-MIGRATION.md`](docs/v2/02-MIGRATION.md) | Phased plan from the v1 kernel to the v2 CLI. |
| [`docs/v2/03-ROADMAP.md`](docs/v2/03-ROADMAP.md) | Six milestones to the backtest. |
| [`docs/v2/04-RISKS.md`](docs/v2/04-RISKS.md) | Technical risks, ordered by severity. |

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

  AUTH-001  The authentication endpoint rejects invalid credentials.
    ✗ vitest · tests/integration/auth.spec.ts::rejects invalid credentials
        expected status 401, received 200
    ✓ semgrep · 0 critical findings

  COV-001   Line coverage must not decrease.
    ✗ c8 · 82.4% → 71.1%  (delta -11.3pp)
```

Every criterion is falsifiable. Every line traces to an artifact digest.

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
