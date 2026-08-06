# Migration Plan — v1 Kernel → v2 Acceptance Layer

How to get from the current repository to the architecture in `01-ARCHITECTURE.md`
without losing the ~15% worth keeping, and without carrying the other 85% along
"just in case."

---

## Principle: cut once, cut early

The temptation is to leave the dashboard and cognitive subsystems in place while
building v2 alongside them. Resist it, for two reasons:

1. **The kernel does not compile** (`00-AUDIT.md` §1). Keeping it means either
   fixing 20+ type errors in code slated for deletion, or permanently excluding
   it from typecheck — which is how the breakage happened in the first place.
2. **Dead code with a `simulate()` that returns model-invented success rates is
   an active hazard** in a repository whose thesis is evidence-based verdicts.
   Someone will eventually import it.

Git history preserves everything. Tag before deleting.

```bash
git tag v1-kernel-archive
git push origin v1-kernel-archive
```

---

## Phase 0 — Preserve and prove the baseline (½ day)

Before removing anything, establish that the repository can tell the truth about
itself. This is a prerequisite, not housekeeping: Genesis's first credibility
test is being a repository Genesis could pass.

1. Tag and push `v1-kernel-archive`.
2. Add `.github/workflows/ci.yml` — there is currently no CI at all. Run
   typecheck, lint, and test on every push.
3. **Fix `"typecheck"`.** It currently runs `tsc --noEmit`, which resolves the
   root config covering `src/` only, which is exactly why the kernel's three
   unresolvable imports went unnoticed. It must cover every TypeScript file in
   the repository, and CI must run it.

Deliverable: a red CI badge that is honest, rather than no badge and a broken
kernel.

---

## Phase 1 — Delete (1 day)

Removed wholesale:

```
kernel/cognitive/          # 1,617 LOC — AXIOM, EVE, ADAM subsystems
kernel/providers/          #   460 LOC — model routing
kernel/api/ws-server.ts    #   604 LOC — dashboard transport
kernel/core/supervisor.ts  #   439 LOC — daemon crash recovery
kernel/core/di-container.ts#   189 LOC
kernel/core/capability-registry.ts # 272 LOC
kernel/storage/vector-store.ts     # 142 LOC
src/                       # 1,166 LOC — React Command Center
index.html vite.config.ts public/ vite-env.d.ts
```

Dependencies dropped from `package.json`: `react`, `react-dom`, `zustand`,
`tailwindcss`, `@tailwindcss/vite`, `lucide-react`, `vite`,
`@vitejs/plugin-react`, `vite-plugin-svgr`, `jsdom`, `@testing-library/*`,
`openai`, `ws`, `@types/ws`, `concurrently`, `@playwright/cli`.

Retained: `better-sqlite3`, `zod`, `uuid`, `dotenv`, `@anthropic-ai/sdk`
(one call site), `tsx`, `typescript`, `vitest`.

Also in this phase:

- `package.json` identity: `"name": "my-app"` / `"version": "0.0.0"` →
  `"name": "genesis-verify"` / `"0.1.0"`, with a `bin` entry for `genesis`.
- `README.md` currently contains the single line `# genesis`. Replace with the
  thesis and a pointer to `docs/v2/`.
- `vitest` config moves out of `vite.config.ts` into a standalone
  `vitest.config.ts` with `environment: 'node'`.

At the end of Phase 1 the repository is small, compiles, and has one honest
(if nearly empty) test suite.

---

## Phase 2 — Rehome what survives (2 days)

### `kernel/storage/sqlite-store.ts` → `src/ledger/store.ts`

The most valuable file in the repository. Changes:

- **Fix the import** — `./kernel-types.js` → `../shared/types.js`. This is one
  of the three unresolvable imports; it is a one-line fix that has been latent
  since the file was written.
- Drop `timeseries`, `blobs`-as-general-store, and the `state`/`state_history`
  tiers. v2 needs Tier 1 (append-only) and a blob store for evidence artifacts.
- Add the `ledger` table with `prev_hash` / `entry_hash`
  (`01-ARCHITECTURE.md` §4.1).
- Route every write through a single `LedgerWriter`. The current
  `AuditLoggerImpl` is freely callable by anyone holding the `Database` handle;
  the v2 writer is the only path, and the chain is computed inside it.

Keep unchanged: WAL, `foreign_keys = ON`, prepared statements, the transaction
discipline in `setState`, and the unique partial index on `idempotency_key`.

### `kernel/events/event-bus.ts` → `src/observability/bus.ts`

- **Fix the import** (same `kernel-types.js` breakage).
- **Fix the DLQ fabrication bug** (`00-AUDIT.md` §2.1): on final failure the
  entry is populated with `Array.from({ length: maxRetries })` synthetic records
  sharing one timestamp and one error, rather than the attempts that actually
  occurred. Record real attempts. In a product about evidence integrity, a
  component that manufactures plausible history cannot ship as-is.
- **Demote it.** Delete the file header's claim that the bus is the only legal
  inter-component channel. It carries `collector.*` progress events for the CLI
  and nothing else; the adjudication path uses direct calls
  (`01-ARCHITECTURE.md` §3.4).
- Drop `sendCommand`/`respondToCommand` — request/response existed for the
  WebSocket server.

### `kernel/security/` → `src/ledger/` + `src/shared/`

- `audit-logger.ts` → folded into `LedgerWriter`. The typed action union and the
  `actor`/`resource`/`outcome`/`details` shape carry over; the standalone table
  does not.
- `secret-store.ts` → keep `redactSecrets()` and wire it into every collector's
  artifact-capture path. Genesis will store CI logs as evidence blobs, and CI
  logs leak tokens. Redaction must happen before the blob is written and before
  the digest is computed, or the digest certifies a redacted-later artifact that
  no longer matches.
- `auth-manager.ts`, `permission-manager.ts`, `ws-security.ts` → deleted for
  MVP. They return with the hosted service, at which point
  `GENESIS_DEV_MODE=true` bypassing every check must not.

### `kernel/core/kernel-types.ts` → `src/shared/types.ts`

Harvest `EventEnvelope`, `EventStoreRecord`, `EventPriority`. Delete the
cognitive types (`ExecutionPlan`, `RoutingPolicy`, `TextGenerationRequest`).

### `kernel/core/lifecycle.ts` → deleted, concept absorbed

The 7-phase boot sequence becomes the `verify` pipeline's phases:
*resolve contract → check pre-registration → collect → adjudicate → record*.
Same discipline, no `LifecycleManager`.

---

## Phase 3 — Build the spine (1 week)

Order matters: each stage is testable against the previous one, and the
Adjudicator is written before any real collector exists so that its purity is
established while it is still cheap to enforce.

1. **`src/shared/canonical.ts`** — RFC 8785 JCS + SHA-256. Tested against the
   RFC's own vectors, plus a property test asserting hash stability under key
   reordering (the failure mode ADAM's `content_hash` documents).
2. **`src/contract/`** — schema (zod), validator, freeze, amend. The validator's
   most important job is rejecting unfalsifiable criteria
   (`01-ARCHITECTURE.md` §2.2).
3. **`src/ledger/`** — chain writer, `verify`, `export`. Test: a direct `UPDATE`
   against the SQLite file must be detected by `ledger verify`, at the right
   `seq`.
4. **`src/adjudicator/`** — the pure function, plus the import-boundary test
   that fails if it reaches for I/O. Written against hand-built evidence
   fixtures.
5. **`src/evidence/`** — envelope types, the admissibility filter, and the
   collector registry interface. No collectors yet.

Gate for Phase 3: `genesis contract freeze` and `genesis ledger verify` work
end to end, and `adjudicate()` produces every verdict class from fixtures.

---

## Phase 4 — Collectors (1 week)

Adapters, in this order, each with recorded fixtures under `fixtures/`:

1. `test` (vitest / jest / pytest JSON reporters)
2. `typecheck` (tsc)
3. `coverage` (c8 / istanbul, base-vs-head delta)
4. `lint` (eslint / biome)
5. `diff` (files, LOC, blast radius, whether auth or migration paths moved)
6. `security` (semgrep)
7. `eve` — the ~150-line adapter over `eve run --json`. **EVE is not modified.**

Each adapter is a pure function from recorded tool output → `Evidence[]`, with
the subprocess execution isolated behind a `Runner` interface. That split is
what makes adapters testable without spawning anything, and it keeps
`provenance` construction in one place.

---

## Phase 5 — Backtest harness (1 week)

`genesis backtest` plus the labeling path. Built last, because it consumes
everything above — and specified first (`01-ARCHITECTURE.md` §7), because the
metrics it reports determine what the rest is for.

The `provenance: reconstructed` flag must exist in the contract schema from
Phase 3, not be retrofitted here. If reconstructed and pre-registered contracts
can ever be pooled into one number, they eventually will be.

---

## Sequencing constraints

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
   CI        delete      rehome       spine     collectors   backtest
   ½d          1d          2d          1w          1w          1w
```

Phases 0-2 are mechanical and low-risk (~3.5 days). Phase 3 is where the design
is actually validated. Phases 4 and 5 parallelize across more than one person;
Phase 3 does not.

---

## What migrates from the sibling repositories

| Source | What | How |
|---|---|---|
| `experience-validation-engine` | The behavioral evidence tier, entire | Process boundary. `eve run --json` or MCP. **Zero changes to EVE.** |
| `ADAM` (`adam-kernel`) | Hash-linked chain + order-independent canonical hashing | Concept ported to TS in Phase 3. No code moves; Rust ≠ TS. |
| `ADAM` (`adam-governance`) | Single-choke-point writer with no bypass | Concept ported into `LedgerWriter`, Phase 3. |
| `AXIOM-AETHER` | Conformal calibration methodology (`/v1/verify`, δ=0.10 on labeled data) | Reference for Phase 5 metrics. No dependency. |

The three sibling repositories keep their own branches and release cadences.
Nothing in this plan modifies them.

---

## Resolved as a side effect: the name collisions

`kernel/cognitive/{axiom,eve,adam}/` share names with three separate shipped
projects. After Phase 1, each name denotes exactly one thing:

- **AXIOM** → the AXIOM-AETHER runtime.
- **EVE** → the Experience Validation Engine, now Genesis's behavioral evidence
  producer, per the brief's instruction to keep them separate.
- **ADAM** → the Rust organism workspace.
- **Genesis** → the acceptance layer. Consumes evidence, renders verdicts,
  keeps the ledger.

This is worth more than the deleted lines. The v1 arrangement made "EVE says the
experience scored 72" ambiguous between a mature cognitive simulation and a
regex counting negative words — and that ambiguity is corrosive in a product
whose output is supposed to be citable.
