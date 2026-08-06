# Genesis v1 Audit

Audit of the existing repository against the v2 thesis: *Genesis is the
acceptance layer for machine-authored work.*

Audited at commit `8590272` on branch `claude/genesis-acceptance-layer-pivot-el0dpp`.
Scope: `fernandogarzaaa/genesis` plus the three sibling repositories
(`experience-validation-engine`, `ADAM`, `AXIOM-AETHER`) that share its vocabulary.

---

## 1. Headline finding: the kernel does not compile

Before any strategic argument about what survives, one mechanical fact dominates
the audit:

```
$ npx tsc --noEmit -p kernel/tsconfig.json
20+ errors
```

Three of them are missing modules:

| File | Line | Imports | Reality |
|---|---|---|---|
| `kernel/events/event-bus.ts` | 13 | `./kernel-types.js` | file lives at `kernel/core/kernel-types.ts` |
| `kernel/storage/sqlite-store.ts` | 11 | `./kernel-types.js` | same |
| `kernel/storage/vector-store.ts` | 6 | `./kernel-types.js` | same |

The event bus, the storage engine, and the vector store — the three components
the pivot brief proposes to *keep* — are all unresolvable imports. The remaining
errors are real type breaks in `axiom-subsystem.ts` (missing `model` on
`TextGenerationRequest`, `stepId` accessed on a shape that lacks it),
`anthropic-provider.ts` (SDK `ContentBlock` drift), `ws-security.ts`
(`ZodError.errors` removed in Zod 4), and `vector-store.ts` (`VectorEntry`
shape mismatch on nearly every field access).

This is not a cosmetic finding. It means **the kernel has never successfully
been built in its current state.** It also explains why: `package.json` defines
`"typecheck": "tsc --noEmit"`, which resolves the *root* `tsconfig.json` — and
that config covers `src/` (the React app) only. The kernel was outside the one
command that would have caught this. There is no CI workflow in the repository
at all.

The test suite is a single smoke test:

```ts
// src/App.test.tsx — the entire suite
it('renders the Genesis shell', () => {
  render(<App />);
  expect(screen.getByText('GENESIS')).toBeInTheDocument();
});
```

**Implication for the pivot.** A product whose entire value proposition is
"we tell you, with evidence, whether machine-authored work is acceptable"
cannot ship from a repository that has zero mechanical evidence about itself.
Whatever else v2 does, Genesis must be the first repository Genesis could pass.
This is not a slogan — it is the cheapest available credibility, and its absence
is currently the loudest fact about the codebase.

---

## 2. Component-by-component verdict

`8,869` lines across 50 files. Verdicts: **KEEP** (survives largely intact),
**REWORK** (concept survives, implementation changes), **DELETE**.

### 2.1 KEEP — genuinely valuable

#### `kernel/storage/sqlite-store.ts` (454 LOC) — **KEEP, rework schema**

The strongest asset in the repository. Three-tier SQLite with WAL, foreign keys
on, and a coherent separation:

- **Tier 1** `events` — append-only log with `correlation_id` / `causation_id` /
  `trace_id`, a unique partial index on `idempotency_key`, and monotonic
  `sequence`.
- **Tier 2** `state` + `state_history` — optimistic concurrency via
  `expectedVersion`, with every prior version retained rather than overwritten.
- **Tier 3** `timeseries` + `blobs`.

The instincts here are exactly right for a ledger: append-only, versioned,
never destructive. `setState` writing history *before* update inside a
transaction (lines 287-330) is correct. The v2 ledger should be built on this
file, not beside it.

One gap that matters enormously for v2 (see §3.1): **nothing is hash-chained.**
Append-only by convention is not append-only under audit.

#### `kernel/events/event-bus.ts` (363 LOC) — **KEEP, demote**

Real work, not scaffolding: wildcard subscriptions compiled to regex (`*` →
`[^.]+`, `#` → `.*`), priority-ordered delivery, a dead-letter queue with
resolution tracking, an idempotency cache, and request/response via
`sendCommand` + `responseChannel`.

Two caveats:

1. **Bug** (lines 339-354): on final failure the DLQ entry is populated with
   `Array.from({ length: maxRetries })` synthetic failure records all stamped
   with the *same* `Date.now()` and the *same* error — it fabricates a retry
   history rather than recording the real one. In a product about evidence
   integrity, a component that manufactures plausible-looking history is a
   liability, not a bug to file later.
2. **Architectural**: the file header declares the bus "the ONLY communication
   channel between components… non-negotiable." For v2 that rule is actively
   harmful — see §3.2.

#### `kernel/security/` (1,078 LOC across 7 files) — **KEEP audit-logger + secret-store, defer the rest**

`audit-logger.ts` has the right shape: typed `AuditAction` union, `actor` /
`resource` / `outcome` / `details`, indexed by timestamp/actor/action/outcome.
`secret-store.ts` and `redactSecrets()` are worth keeping — a verifier that
prints CI logs will handle credentials, and redaction-at-the-boundary is
already wired into the boot path.

`auth-manager.ts`, `permission-manager.ts`, `ws-security.ts` exist to protect a
long-lived WebSocket server. A CLI has no such surface. Defer, don't delete
the ideas — they return when Genesis runs as a hosted CI service.

Note `GENESIS_DEV_MODE=true` short-circuits every check in `ws-security.ts`
(lines 216, 262, 311 all `return { allowed: true }`). Acceptable for a local
kernel; unacceptable for anything that gates merges. Flagged for whenever the
service mode returns.

### 2.2 DELETE — actively contradicts the v2 thesis

#### `kernel/cognitive/axiom/axiom-subsystem.ts` (512 LOC) — **DELETE**

This is the clearest case in the audit. AXIOM's `execute()` "runs" a plan step
by sending the step's text to an LLM with:

```ts
content: `You are executing a step in a larger plan. Goal: "${plan.goal}".
          Execute this step and return only the result.`
```

Nothing is executed. The model narrates a plausible outcome and the narration
is stored as `step.result`, then published as `cog.task.step_completed` with a
`tokensUsed` metric that lends it the texture of a real measurement.

`simulate()` (lines 327-378) is worse for our purposes. It asks a model to
estimate its own success rate, then regex-scrapes a percentage out of the prose:

```ts
const successRate = this._extractPercentage(result.answer, 'success') ?? 0.6;
```

…and converts it into a `pass` / `revise` / `escalate` recommendation via fixed
thresholds. **This is precisely the failure mode v2 exists to eliminate:** a
model grading its own work, producing a confident verdict with no evidence
underneath, dressed in the visual language of measurement. The `?? 0.6` default
means a model that answers unparseably still yields "60% likely to succeed."

`_parsePlanSteps` regex-parsing free-text into a typed `ExecutionStep[]` is the
same category — structure imposed on prose, then treated as if it were data.

Delete the subsystem. Do not port any of it.

#### `kernel/cognitive/eve/eve-subsystem.ts` (636 LOC) — **DELETE**

Contains `_estimateHallucinationRisk()`, `_estimateSentiment()`,
`_hasContradictions()`, `_containsHarmfulContent()`, and `_simpleEmbed()` — all
keyword/heuristic stubs producing scores in `[0,1]`. These would become
"behavioral evidence" in v2, and they would be fabricated behavioral evidence.

It also collides in name with the real EVE (§4.1), which is a shipped product
that does this work properly. The collision is not cosmetic: it makes "EVE says
the experience scored 72" ambiguous between a mature simulation engine and a
regex that counts negative words.

#### `kernel/cognitive/adam/adam-subsystem.ts` (469 LOC) — **DELETE**

Pattern consolidation, strategy optimization, and a proposal approve/reject
lifecycle. The proposal-gate concept survives into v2's ledger; the
implementation does not. Same name collision as EVE — the real ADAM (§4.2) is a
Rust workspace whose governance gate is a better version of this idea.

Also: the brief explicitly excludes "ADAM self-improvement" from the first
product. A subsystem that mutates Genesis's own thresholds is the single most
dangerous thing to keep in a component whose value is that its verdicts are
stable and auditable.

#### `kernel/providers/` (460 LOC) — **DELETE**

`ProviderRegistry` + OpenAI + Anthropic adapters with a `RoutingPolicy`
(`balanced` / cost / quality tiers, health scores, `costPerUnit`). This is a
model router. The brief names model routing as occupied territory
(OpenRouter, LiteLLM) and instructs Genesis not to compete there.

v2 needs exactly one LLM call path — the judgmental evidence producer — and it
should be a thin, single-provider client behind an interface, not a routing
layer with SLA tiers.

#### `kernel/api/ws-server.ts` (604 LOC) — **DELETE for MVP**

A WebSocket command surface (`task.submit`, `proposal.approve`, `audit.query`,
`system.command`, `pause`/`resume`) whose only client is the dashboard.

#### `src/` — the React Command Center (1,166 LOC) — **DELETE for MVP**

`App.tsx` (444 LOC) plus Dashboard / Tasks / Proposals / Plugins / Memory /
Security views, Zustand stores, Tailwind, a `kernel-client.ts` WebSocket client.
Competent work. The brief is unambiguous that the first milestone is not a UI
demo, and a dashboard is the single most effective way to make an unfalsifiable
system *feel* validated.

Delete it from the build. The git history retains it; tag before removal.

#### `kernel/storage/vector-store.ts` (142 LOC) — **DELETE for MVP**

In-memory cosine similarity over `_simpleEmbed` hashes. Semantic search across
the ledger is a real phase-3 feature; this is not the implementation of it, and
nothing in the MVP needs embeddings.

### 2.3 REWORK

| Component | LOC | Disposition |
|---|---|---|
| `kernel/core/lifecycle.ts` | 180 | Collapse. A CLI has `main()`, not a 7-phase boot. |
| `kernel/core/supervisor.ts` | 439 | Delete for MVP. Crash-recovery and heartbeats belong to a daemon; a `verify` run either completes or exits non-zero. |
| `kernel/core/di-container.ts` | 189 | Delete. Constructor injection suffices at this size. |
| `kernel/core/capability-registry.ts` | 272 | Delete as-is; the *collector registry* in v2 borrows the versioned-provider idea at a fraction of the complexity. |
| `kernel/core/kernel-types.ts` | 252 | Harvest `EventEnvelope` / `EventStoreRecord`; drop the cognitive types. |
| `package.json` | — | Currently `"name": "my-app"`, `"version": "0.0.0"`. Becomes the published CLI identity. |
| `README.md` | 1 | Contains the single line `# genesis`. |

### 2.4 Tally

| Verdict | Files | ~LOC | Share |
|---|---|---|---|
| KEEP / KEEP-rework | 5 | ~1,300 | 15% |
| REWORK (harvest) | 2 | ~400 | 4% |
| DELETE | 43 | ~7,200 | 81% |

The pivot is a rewrite that inherits a storage engine, an event bus, an audit
logger, and a set of good instincts about append-only data.

---

## 3. Architectural gaps the audit exposes

These are not v1 defects; they are requirements v1 never had and v2 cannot ship
without.

### 3.1 Nothing is tamper-evident

`audit_log` and `events` are ordinary SQLite tables. Any process with the file
handle can `UPDATE` a verdict, `DELETE` an inconvenient failure, or backdate a
contract. Every table indexes `timestamp` — a column supplied by the writer.

The v2 thesis states the ledger *is* the asset and the future training data. An
asset that can be silently edited is not an audit record, and a calibration
dataset that can be silently edited is not evidence of calibration. **Hash
chaining is a v2 launch requirement, not a hardening task.** See
`01-ARCHITECTURE.md` §4.

### 3.2 The "event bus is the only channel" rule conflicts with determinism

`event-bus.ts` opens by declaring inter-component communication through direct
calls "non-negotiable." Under that rule, adjudication would be an async fan-out
whose result depends on handler registration order, retry timing, and DLQ state.

v2's central invariant is the opposite: **the verdict must be a pure,
deterministic function of (frozen contract, evidence set)** — same inputs, same
verdict, byte for byte, forever. That property is what separates an audit layer
from an AI code reviewer, and it is not achievable through a retrying,
priority-sorted, dead-lettering message bus.

This is the one place where the audit recommends against the pivot brief's
"keep the event bus" instruction as written. The bus survives — for collector
progress, streaming CLI output, and the eventual service mode — but it is
demoted from *architecture* to *observability*, and the adjudication path uses
direct calls. Rationale in `01-ARCHITECTURE.md` §3.4.

### 3.3 There is no notion of evidence provenance

v1 events carry `source: { component, instance, host }`. That answers "which of
our subsystems emitted this," which is the wrong question. v2 must answer:
*what command produced this, against what commit, in what environment, with
what exit code, and what is the digest of the raw artifact?* Nothing in v1
records any of it.

### 3.4 There is no concept of a contract, frozen or otherwise

`submitTask(goal, context)` takes a free-text goal. Nothing is falsifiable,
nothing is hashed, nothing is timestamped against a base commit, and there is
no representation of "what would prove this is done." The Contract Compiler is
net-new.

---

## 4. Sibling repositories

### 4.1 `experience-validation-engine` (EVE) — **KEEP, integrate as-is, do not absorb**

v0.3.1, 255 files, MIT, CI green, release-please, Biome, published `eve` and
`eve-mcp` binaries. This is a real product and it is materially more mature than
Genesis.

It is also, without modification, exactly the behavioral evidence producer the
v2 thesis calls for:

- **Deterministic under seed.** `src/core/random.ts` implements mulberry32 with
  the explicit contract "given the same seed, persona and application state, EVE
  takes the same path. All stochastic behavior draws from a session-scoped
  `Rng` rather than `Math.random`." Reproducible seeded scenarios are a stated
  v2 evidence requirement; EVE already satisfies it.
- **Structured, citable output.** `SessionResult` carries `seed`, `findings`
  (each with `severity`, `category`, `evidence: readonly string[]`, `url`,
  `timestamp`, optional `screenshotIndex`), `scores` by dimension,
  `goalAchieved`, `abandoned`, `abandonReason`. Findings already cite evidence.
- **A structural no-privileged-information boundary** — the operator perceives
  only what a human perceives. That independence is the same property Genesis
  needs between executor and grader, one layer down.
- **`eve_compare_builds`** already exists in the MCP surface: behavioral
  regression between two builds is a first-class operation.

**Recommendation: never merge EVE into Genesis.** Consume it across a process
boundary (CLI `eve run --seed N --json`, or the MCP tools
`eve_run_session` / `eve_compare_builds` / `eve_get_report`) and treat its JSON
as one more evidence envelope. Two arguments, both decisive:

1. It preserves the neutrality principle. Genesis adjudicates evidence it did
   not author. If EVE lives inside Genesis, Genesis is grading its own output.
2. EVE has independent value and an independent release cadence. Absorbing it
   trades a shipping product for a subdirectory.

The integration cost is a ~150-line adapter mapping `SessionResult` → evidence
envelopes. That is the whole of the behavioral evidence tier for the MVP.

### 4.2 `ADAM` (Rust workspace) — **Port two concepts, port no code**

Not a dependency — Rust, and its purpose (a self-evolving organism) is outside
the v2 scope. But it contains the two primitives Genesis v2 most needs, already
thought through:

**`adam-kernel` — hash-linked version chains.** From `ARCHITECTURE.md`:

> `GenomeHistory`: an append-only, hash-linked version chain. `rollback` never
> rewrites history — it commits a new version whose content matches a prior one.
> `content_hash` is order-independent (canonicalized JSON) so two genomes with
> identical content always hash identically regardless of `HashMap` iteration
> order.

That is the contract-freezing primitive of §3.1 and `01-ARCHITECTURE.md` §2,
including the canonicalization subtlety that makes hashes stable — and the
amendment-not-mutation discipline v2 requires for contract amendments.

**`adam-governance` — the single choke point.** From `gate.rs`:

> the single choke point every mutation acceptance, rejection, and rollback must
> pass through… no path exists to change the organism's genome or skill set
> without leaving a record here.

Genesis's ledger needs precisely this property for verdicts, and v1's
`audit-logger` — which any caller may bypass — does not have it.

`adam-beliefs` (evidence-driven confidence, competing-belief resolution) is
relevant later, when the ledger starts informing verdicts rather than merely
recording them. Not MVP.

### 4.3 `AXIOM-AETHER` — **Do not merge. Note as prior art; optional collector later.**

A large Rust runtime for test-time training, context compression, and proxying.
Unrelated to acceptance verification and far too large to absorb.

Two things are worth extracting as *knowledge*:

- **`/v1/verify` ships a conformal trust gate**, calibrated on
  `bench/trust/claims.jsonl` at δ=0.10 for ≥90% coverage of genuinely supported
  claims, with a `calibrate` request mode for retuning on labeled data. Genesis
  v2's calibration story needs exactly this statistical treatment. Prior art
  inside the same org; reuse the method, not the crate.
- **ChimeraLang emits "tamper-evident run certificates."** Same instinct as
  §3.1, already implemented once here.

**Naming collision, worth resolving deliberately.** `kernel/cognitive/axiom/`
(a 512-line LLM planner that executes nothing) shares a name with AXIOM-AETHER
(a substantial shipped runtime). Deleting the v1 cognitive subsystems resolves
all three collisions — AXIOM, EVE, and ADAM — as a side effect. That is a real
benefit: after the pivot, each name denotes exactly one thing.

---

## 5. Answers to the four questions

**1. What survives?**
The storage engine (as the ledger's foundation), the event bus (demoted to
observability), the audit logger and secret redaction (upgraded to hash-chained),
and `EventEnvelope`'s correlation/causation/trace discipline. Externally: EVE,
untouched, as the behavioral evidence producer. Roughly 15% of the code, and the
better 15%.

**2. What should be deleted?**
All three cognitive subsystems (1,617 LOC), the provider registry and model
routing (460), the WebSocket server (604), the entire React dashboard (1,166),
the vector store (142), and the DI/supervisor/lifecycle/capability scaffolding
(1,080). ~5,000 LOC directly, ~7,200 including the harness around it.

The AXIOM subsystem is the priority deletion: an LLM narrating its own success
rate, parsed by regex into a `pass`/`revise`/`escalate` verdict, is the exact
anti-pattern v2 is positioned against. It cannot coexist with the thesis in the
same repository.

**3. What architecture changes are required?**
Four, in dependency order:

1. **Contract pre-registration** — a frozen, content-hashed, base-commit-bound
   artifact with falsifiable criteria. Net-new.
2. **A tamper-evident ledger** — hash-chained entries over the existing SQLite
   engine. Without it the moat is a mutable file.
3. **Evidence provenance** — every record carries the command, exit code,
   environment digest, seed, and artifact digest that produced it, plus an
   admissibility rule that rejects evidence authored by the executor.
4. **Deterministic adjudication** — the verdict as a pure function over
   (contract, evidence), with mechanical failure terminal and non-overridable.
   This forces the event bus out of the decision path.

**4. Genesis v2 architecture?**
See `01-ARCHITECTURE.md`.

---

## 6. One risk that outranks the others

The audit surfaces a structural temptation, and it is worth naming here rather
than burying it in the risk register.

v1 already built a system that produces confident verdicts with nothing
underneath them — `simulate()` returning `successRate: 0.6` because a regex
failed to match. It did so without anyone intending it. The same gravity acts on
v2: an Adjudicator that cannot reach a conclusion is *useful* if it says
HUMAN REVIEW, and *worthless-but-impressive* if it guesses.

Every design decision in `01-ARCHITECTURE.md` that looks conservative — missing
evidence can never yield SHIP, LLM judgment can never be terminal in either
direction, evidence the executor produced is inadmissible, defaults never
substitute for measurements — exists to resist that gravity. They are the
product. Relaxing any of them converts Genesis into a better-branded AI code
reviewer, which the brief correctly identifies as too weak a position to hold.
