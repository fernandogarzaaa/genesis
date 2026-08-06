# MVP Roadmap

Six milestones. The validation artifact is the backtest at M4 — not a demo, not
a UI, not a green CI badge.

Estimates assume one engineer working continuously. They are engineering
estimates, not commitments.

---

## M0 — Genesis passes its own bar (½ day)

**Ship:** CI workflow; `typecheck` fixed to cover the kernel, not just `src/`;
`v1-kernel-archive` tag pushed.

**Why first:** the kernel currently does not compile (`00-AUDIT.md` §1), and the
one command that would have caught it was silently scoped to the React app. A
product that adjudicates other people's evidence must first be able to produce
its own. This is the cheapest credibility available and its absence is the
loudest fact about the repository today.

**Done when:** CI runs on push and its result — whatever it is — is true.

---

## M1 — Frozen contracts (1 week)

**Ship:**
```
genesis contract init --objective issue.md --repo .
genesis contract freeze --contract contract.json
genesis ledger verify
```

- RFC 8785 canonicalization + SHA-256, tested against the RFC's vectors and a
  property test for key-order stability.
- Contract schema with enforced falsifiability — `"Users can login securely"`
  is **rejected by the validator**, not flagged in review.
- Hash-chained ledger with a single writer and no bypass.
- Amendment path (`supersedes` + reason), chain retained.

**Done when:** a contract can be frozen, and a hand-edit to any row of the
SQLite file is caught by `ledger verify` at the correct `seq`.

**Why before collectors:** contract pre-registration is the load-bearing design
rule of the whole thesis. If freezing and the chain are not solid, every
downstream verdict is unanchored. It is also the piece with no external
dependencies — nothing blocks it.

---

## M2 — First real verdict (1.5 weeks)

**Ship:** `genesis verify --repo . --contract contract.json` with the mechanical
tier: test, typecheck, coverage delta, lint, diff analysis.

- The pure Adjudicator, with the import-boundary test enforcing purity.
- Evidence envelopes with full provenance and artifact digests.
- The admissibility filter — evidence carrying `produced_by: "executor"` is
  recorded and excluded (`01-ARCHITECTURE.md` §3.2).
- The three verdicts, with distinct exit codes (0 / 1 / 2, and 3 for Genesis
  itself failing).

**Done when:** Genesis renders `NOT READY` on a deliberately broken PR in a real
repository, and every failed criterion in the output traces to an artifact
digest that can be reproduced from the ledger.

**Dogfood target:** the first repository verified is `genesis` itself. Second is
`experience-validation-engine`, which has real CI, real coverage, and a real
test suite — a genuine subject rather than a fixture.

---

## M3 — Behavioral evidence (1 week)

**Ship:** the EVE adapter. `SessionResult` → evidence envelopes, seeds recorded
in provenance, `eve_compare_builds` for base-vs-head behavioral regression.

**Done when:** a contract criterion expressed in user-experience terms — *"a
locked-out user is told why and for how long"* — is satisfied or failed by a
seeded EVE session, and re-running with the same seed yields a byte-identical
evidence envelope.

**Why this milestone matters disproportionately:** it is the only claim in the
architecture that no competitor can make cheaply. Mechanical evidence is
commodity — everyone can run a test suite. Reproducible *behavioral* evidence
from an independent cognitive simulation, already shipped and already
deterministic under seed, is the differentiated tier. It is also the cheapest
milestone on the list, because EVE is not modified.

---

## M4 — The backtest (2 weeks) — **the actual validation artifact**

**Ship:** `genesis backtest --dataset prs.jsonl --report backtest.html`, plus
the outcome-labeling path (GitHub webhook + `genesis label` + a backfill script).

**Dataset:** 30 merged-clean PRs and 30 reverted/hotfixed PRs, drawn from real
repositories. Contracts reconstructed from issues and diffs, and every one of
them flagged `provenance: reconstructed` — never pooled with pre-registered
contracts in any reported figure (`01-ARCHITECTURE.md` §7.1).

**Report:** false-ship rate, block rate on good work, coverage, escalation
precision, and per-collector ablation lift — each with a Wilson interval, and
with the base-rate caveat stated in the report itself rather than in a footnote.
A balanced 30/30 sample measures discrimination; real repositories revert 2-5%
of PRs, so it does not measure deployed precision and the report must say so.

**Done when the honest version of this sentence can be written:**

> Across 60 historical PRs with reconstructed contracts, Genesis returned SHIP
> on N of 30 problematic changes (false-ship rate X%, 95% CI [a, b]) and
> NOT READY on M of 30 clean merges. Coverage was C%. The signal that
> contributed most was `<collector>`; ablating it moved the false-ship rate by Δ.

**The bar is not a high score.** It is zero false SHIPs on the reverted set with
non-trivial coverage on the merged set. A system returning `HUMAN REVIEW` for
everything achieves half of that and is worthless; the report must make that
failure mode visible rather than let it hide inside an accuracy number.

**A negative result is a valid and valuable outcome here.** If the mechanical
tier alone cannot discriminate reverted from clean PRs, that is the most
important thing this project could learn in its first two months, and it is
learnable for the price of two weeks rather than two years.

---

## M5 — CI gate (1 week)

**Ship:** GitHub Action. Contract frozen at issue-assignment time; `verify` on
every push to the PR; verdict posted as a check run with the evidence table;
outcome labels captured automatically from merge/revert webhooks.

**Done when:** Genesis gates a real PR in a real repository, and the ledger
accumulates pre-registered verdict/outcome pairs without anyone running a
command by hand.

**Why last:** this is what starts the calibration flywheel — the first
pre-registered contracts, which are the only ones that measure whether Genesis
actually works. Shipping it before M4 would fill the ledger with data whose
verdict logic had not yet been validated.

---

## Timeline

```
M0  ½d   ██
M1  1w   ████████
M2  1.5w ████████████
M3  1w   ████████
M4  2w   ████████████████
M5  1w   ████████
         └─────────────────────────────────┘
              ~6.5 weeks to first backtest
```

M2/M3 and M4/M5 parallelize across two engineers. M1 does not — it is the
foundation everything else hashes against.

---

## Explicitly out of scope

Per the brief, and restated here because each of these will be tempting at
roughly the moment the CLI starts working:

- Dashboard or web UI. Not until the CLI's verdicts have been backtested.
- Autonomous execution. Genesis has no write path to the working tree.
- Model routing. One provider, one call site.
- ADAM-style self-improvement. A component that tunes its own thresholds
  destroys the reproducibility the ledger depends on. Recalibration is a
  deliberate, versioned, human-initiated act.
- Plugin ecosystem. The collector registry is an internal interface until there
  is a reason for it to be a public one.

---

## Success criteria for the MVP as a whole

1. Genesis renders reproducible verdicts on real PRs, and every verdict is
   replayable from the ledger to a byte-identical result.
2. The ledger is tamper-evident and holds ≥60 verdict/outcome pairs.
3. The backtest report exists, is honest about its intervals, and segregates
   reconstructed from pre-registered contracts.
4. The false-ship rate on pre-registered contracts is measured — not estimated,
   not asserted.

Note what is absent: no adoption target, no revenue target, no demo. At this
stage the only question worth answering is whether the verdicts correspond to
reality, and that question has a number attached to it.
