# Technical Risks

Ordered by how much damage each does if it turns out to be real. The first three
are existential to the thesis, not to the schedule.

---

## R1 — The agent games the contract *(highest severity, no complete mitigation)*

**The problem.** The agent must see the contract — it cannot build to a spec it
cannot read. But a contract that says

> criterion AUTH-001 is satisfied when `tests/integration/auth.spec.ts::rejects
> invalid credentials` passes

is trivially satisfied by writing that test as `expect(true).toBe(true)`. The
agent optimizes for the stated objective, which is the evidence, not the intent
behind it. This is Goodhart's law with a code generator attached, and it will
not announce itself — a gamed contract looks exactly like a satisfied one.

**Mitigations, none sufficient alone:**

1. **Flag same-diff test authorship.** If a criterion's only passing evidence
   comes from a test file introduced or modified in the diff under evaluation,
   the criterion cannot reach `SATISFIED` — it caps at `HUMAN REVIEW`. Cheap,
   mechanical, and catches the naive case outright. Implement in M2.
2. **Pre-registered tests.** Where a human or Genesis authors the test at
   contract time, hash the test file into the contract. Evidence from a file
   whose digest changed is inadmissible for that criterion.
3. **Behavioral evidence is much harder to game.** An EVE session driving a real
   browser toward a goal cannot be satisfied by editing an assertion — the agent
   would have to actually make the flow work. This is the strongest argument for
   prioritizing M3 and for the "keep EVE separate" decision generally.
4. **Mutation testing and coverage-delta as anti-gaming evidence.** A test that
   asserts nothing dies to mutation. Phase 2, not MVP.
5. **Independent probes.** `http-probe`-style criteria assert externally
   observable behavior (status codes, response shapes) rather than the outcome
   of a test the agent controls.

**Residual risk: high, and permanent.** A sufficiently capable agent that can
read the contract can eventually satisfy it dishonestly. The honest framing is
that Genesis raises the cost of faking completion above the cost of achieving
it, and — crucially — **records the attempt**. The ledger's same-diff-authorship
flags become their own dataset, and detection of gaming is itself a calibration
target. Do not claim gaming is solved. Claim it is measured.

---

## R2 — The evidence does not predict the outcome

**The problem.** The entire moat rests on the premise that mechanical and
behavioral signals discriminate PRs that get reverted from PRs that don't. That
premise is unvalidated. Plausible outcome: PRs get reverted for reasons no
pre-merge signal can see — a product decision changed, a dependency was
deprecated upstream, load characteristics differed in production, someone
merged the wrong branch.

If green tests, stable coverage, and a clean scan are equally common among
reverted and clean PRs, Genesis is an expensive way to re-run CI.

**Mitigation:** this is exactly what M4 measures, which is why the backtest is
the validation artifact rather than a demo. Per-collector ablation lift is the
diagnostic — it says not just *whether* the evidence discriminates but *which*
evidence does.

**If the answer is "it doesn't":** the finding is genuinely valuable, and it
arrives in week six rather than year two. The likely response is to move
investment toward behavioral evidence (R1's mitigation 3) and toward the
diff-risk signals — blast radius, whether auth or migration paths moved, novelty
relative to repository history — which are closer to the actual causes of
reverts than test outcomes are.

**Residual risk: medium-high, and unresolvable except by measurement.** Any plan
that does not put this question first is deferring it, not answering it.

---

## R3 — HUMAN REVIEW swallows everything

**The problem.** Every conservative rule in `01-ARCHITECTURE.md` §5 pushes
toward `HUMAN REVIEW`: missing evidence, collector errors, contested judgment,
late amendments, same-diff test authorship. Each is individually correct. Their
composition may be a system that says "ask a human" on 85% of PRs, which is
precisely the status quo it exists to replace, now with extra latency.

**Mitigation:** coverage — `P(verdict ≠ HUMAN REVIEW)` — is a first-class M4
metric, not an afterthought, and it is reported alongside the false-ship rate
specifically so neither can be optimized in isolation. If coverage is low, the
fix is more and better collectors, never a relaxed lattice.

**The rule that must not bend:** loosening §5.4 — letting missing evidence yield
`SHIP` — would raise coverage instantly and destroy the product. A gate that
opens when it fails is not a gate. If the tension ever needs resolving, it gets
resolved by adding evidence, not by lowering the bar.

**Residual risk: medium.** Measurable, and the response is well-defined.

---

## R4 — Contract authoring is too expensive for anyone to do it

**The problem.** Writing a falsifiable contract before starting work is real
effort — arguably harder than the work itself for small changes. If contract
authoring costs 20 minutes, nobody pre-registers, everyone reconstructs after
the fact, and pre-registration — the design rule the whole thesis rests on —
becomes a documented ideal that is never practiced.

**Mitigations:**

1. **Assisted mode** drafts criteria from an issue; the human edits and confirms
   rather than authoring from scratch. The LLM cannot weaken a contract
   (`01-ARCHITECTURE.md` §2.2), so assistance is safe.
2. **Contract templates by change class** — bugfix, feature, refactor,
   dependency bump. A refactor's contract is largely "behavior is unchanged,"
   which is highly templatable and is also the case where mechanical evidence is
   strongest.
3. **Repository-level `global_gates`** written once (coverage floor, typecheck
   clean, no critical findings) and inherited by every contract. Many PRs then
   need zero bespoke criteria.
4. **Freeze at issue-assignment time**, inside the M5 GitHub Action, so it
   happens automatically at the moment the objective already exists in prose.

**Residual risk: medium.** This is an adoption risk more than a technical one,
but it can silently hollow out the architecture — the ledger fills with
`reconstructed` contracts, and the headline metric quietly stops measuring what
it claims to.

---

## R5 — The judgmental tier degrades into an AI code reviewer

**The problem.** The LLM tier is the easiest thing to expand and the hardest to
resist expanding. It handles ambiguity gracefully, it produces impressive prose,
and every `UNPROVEN` criterion is an invitation to "just ask the model."
Incrementally, Genesis becomes an AI code reviewer with a ledger attached —
which the brief correctly identifies as too weak a position to hold.

**Mitigations, all structural rather than cultural:**

1. Judgmental evidence has **no path to `NOT READY` and no path to `SHIP`**. Its
   only power is to raise a hand (`CONTESTED` → `HUMAN REVIEW`). This is
   stricter than the brief requires, deliberately (§5.4).
2. **The removal test**, run as an actual test: with the judgmental collector
   disabled entirely, the suite must still pass and verdicts must only shift
   toward `HUMAN REVIEW`. If deleting the LLM breaks Genesis, Genesis has become
   the thing it was built to replace.
3. Uncited model claims are dropped by the adapter, not passed through with a
   caveat.
4. Model, version, prompt digest, and temperature are recorded, so drift is
   visible in the calibration data rather than invisible in the verdicts.

**Residual risk: low, if the removal test is written in M2** — while the
judgmental tier is still hypothetical and the test is trivially satisfiable.
Adding it later, once the tier exists and is load-bearing, will be politically
hard in exactly the way that matters.

---

## R6 — Determinism erodes

**The problem.** `adjudicate()` is pure on day one. Then someone needs the
current time for a staleness check, or a config lookup for a threshold, or a
network call to resolve a CVE severity. Each is individually reasonable. The end
state is that replaying the ledger produces different verdicts than it did
originally, and the calibration dataset — the moat — becomes uninterpretable,
because you can no longer tell whether a verdict changed due to the evidence or
due to the verifier.

**Mitigations:**

1. **Import-boundary test.** `src/adjudicator/**` may import only type modules —
   no `fs`, no `http`, no `Date.now`, no config. Enforced by a failing test
   (`01-ARCHITECTURE.md` §8).
2. **Ledger replay in CI.** Every recorded verdict is recomputed by the current
   adjudicator and diffed. A behavior change surfaces as a red build.
3. **`adjudicator_version` in every verdict entry.** When the logic *must*
   change, it changes as a versioned migration with a documented rationale, and
   the ledger records which version rendered which verdict — so cross-version
   comparisons are possible rather than merely tempting.

**Residual risk: low**, and entirely dependent on tests M2 must ship with.

---

## R7 — Evidence collection is not hermetic

**The problem.** Collectors run tests, which touch networks, clocks, filesystems,
and each other. A flaky test produces `fail` on one run and `pass` on the next,
and the ledger records a `NOT READY` verdict backed by a fact that was never
stable. Enough of that and the ledger's evidentiary value decays — every entry
carries an unquantified probability of being noise.

**Mitigations:**

1. `env_digest` in provenance captures runtime version, lockfile digest, OS, and
   container image, so identical-input claims are checkable rather than assumed.
2. Flake detection: re-run failing mechanical collectors once. A pass on retry
   yields `status: "flaky"`, which maps to `UNPROVEN` → `HUMAN REVIEW` rather
   than `FAILED`. Blocking a merge on a coin flip is worse than escalating.
3. Flake rate per collector is itself a ledger-derived metric and belongs in the
   M4 report — a collector that is flaky 15% of the time is contributing noise,
   and ablation lift will show it.

**Residual risk: medium.** Endemic to every CI system; Genesis's exposure is
higher only because it records the results permanently and later trains on them.

---

## R8 — Sandbox escape / running untrusted code

**The problem.** `genesis verify` executes commands from a repository that an
autonomous agent just modified. The MVP posture — subprocess, scrubbed
environment, timeout — is adequate for a developer running it locally on their
own code. It is **not** adequate for a hosted service verifying arbitrary
repositories, where "run the repo's test command" is a remote code execution
feature with a friendly name.

**Mitigations:**

1. MVP is a locally-run CLI. The trust boundary is the user's own machine, which
   is where their code was going to run anyway.
2. Commands come from the contract and `genesis.config.json`, not from arbitrary
   discovery. A verification command introduced or modified in the diff under
   evaluation is flagged and caps the criterion at `HUMAN REVIEW` — the same
   mechanism as R1's mitigation 1, applied to the runner rather than the tests.
3. Container isolation with no network and no credentials is a **hard
   prerequisite for M5's hosted mode**, and is listed here so it is not
   discovered during it.

**Residual risk: low for MVP, high for the hosted service.** The mitigation is
schedule discipline: do not ship hosted verification before containerization.

---

## R9 — SQLite as the ledger substrate

**The problem.** The ledger is single-writer, single-host, and lives in a file.
It does not survive the container it runs in. Hash chaining makes tampering
*detectable*, but a local file offers no protection against deletion, and
"the calibration dataset was on a laptop" is an unserious answer for the asset
the entire strategy rests on.

**Mitigations:**

1. `genesis ledger export --format jsonl` from M1, so the chain is portable and
   backup is a one-liner rather than a project.
2. Anchor the head hash periodically into a signed git tag in the repository
   under verification — cheap, and converts detectability from
   self-attested to externally checkable.
3. Postgres is a later swap. Keep all SQL behind the `LedgerWriter` interface so
   it stays a swap and not a rewrite.

**Residual risk: low near-term, medium once the data has real value.** Worth
noting that this risk *grows* with the project's success, which makes it easy to
defer past the point where deferring was safe.

---

## R10 — EVE coupling

**The problem.** The behavioral tier depends on a separate repository with its
own release cadence. A breaking change to `SessionResult` breaks Genesis's
adapter. `experience-validation-engine` has already shipped major-version
dependency bumps (`zod` 3→4, `typescript` 5→7, `vitest` 3→4, Node 18 dropped),
so its surface does move.

**Mitigations:** pin an exact EVE version in the collector registry and record
it in `collector.version`; test the adapter against recorded `SessionResult`
fixtures so a schema change fails Genesis's CI rather than a user's verify run;
treat the JSON boundary as a versioned contract in both directions.

**Residual risk: low.** This is ordinary dependency management, and the process
boundary is what makes it ordinary — the alternative, absorbing EVE, trades this
small risk for the loss of the neutrality property.

---

## Risk summary

| # | Risk | Severity | Residual | First mitigated in |
|---|---|---|---|---|
| R1 | Agent games the contract | Critical | **High** | M2 (flag), M3 (behavioral) |
| R2 | Evidence doesn't predict outcomes | Critical | **Med-High** | M4 |
| R3 | HUMAN REVIEW swallows everything | High | Medium | M4 |
| R4 | Contract authoring too expensive | High | Medium | M1, M5 |
| R5 | Degrades into an AI code reviewer | High | Low* | M2 |
| R6 | Determinism erodes | High | Low* | M2 |
| R7 | Collection not hermetic | Medium | Medium | M2 |
| R8 | Sandbox escape | Med → High | Low* | M5 |
| R9 | SQLite substrate | Medium | Low | M1 |
| R10 | EVE coupling | Low | Low | M3 |

\* Low *only if* the specified test or prerequisite ships in the named
milestone. Each of R5, R6, and R8 is cheap to prevent while the relevant code is
still hypothetical, and expensive to retrofit once it is load-bearing. R5's
removal test in particular is trivially satisfiable in M2 and will be
contentious in M6.

---

## The two risks that decide whether this works

R1 and R2 are the project. Everything else is engineering.

**R2 is answerable in six weeks** and the answer is a number. That is why the
roadmap puts the backtest before the CI gate, and before anything with a
user interface.

**R1 is not fully answerable, ever.** The realistic goal is to make dishonest
satisfaction more expensive than honest satisfaction, and to record every
suspicion in a ledger that gets better at recognizing the pattern. Any
positioning that implies gaming is solved will be falsified by a sufficiently
capable agent, publicly, at the worst possible moment. Position on measurement,
not on immunity.
