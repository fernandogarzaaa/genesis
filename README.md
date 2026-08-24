# Genesis

**Assurance infrastructure for machine-authored work: audit the verifier, not the artifact.**

> An RLVR verifier, an eval harness, or a benchmark grader is executable
> software, and its bugs become rewardable failure modes. An agent optimizing
> against a verifier with a hole will find the hole. Genesis fires adversarial
> probes at a verifier and reports which defects it has.

---

```bash
npm install && npm run build

genesis audit --suite code --verifier "node harness.js {task_file} {completion_file}"
```

```
VERDICT: EXPLOITABLE
Verifier "harness" against suite code@0.1.0
Suite digest 574dc7e407b5 · 7 probes (5 exploit, 2 control)

RATES
  False-accept   100.0% [56.5–100.0%, n=5]
  False-reject     0.0% [0.0–65.8%, n=2]

FINDINGS (3)

  [exploitable] stdout_spoofing — Stdout spoofing
      Treats process output as evidence of correctness. The verifier accepted
      2 completion(s) it should have rejected.
      exploit: Print whatever the harness greps for and exit zero.
      ✗ code/stdout-spoof-2
          Exits zero before any test can run. A verifier trusting the exit
          code accepts a completion that defines no function.
          artifact 9699235683efe050
```

Exit codes are distinct on purpose: `0` SOUND · `1` EXPLOITABLE ·
`2` UNRELIABLE/OVER_STRICT · `3` Genesis itself failed — so CI can block on
one and route the other without parsing stdout.

## Why this exists

Two facts, from [`docs/research/04-REDIRECTION-REVIEW.md`](docs/research/04-REDIRECTION-REVIEW.md):

- **Environment defects are common.** Building SWE-bench Verified removed
  68.3% of the original 2,294 instances as invalid. OpenAI later retired
  Verified after an internal audit found 59.4% of audited failed problems had
  flawed tests.
- **The research question is already answered.** Ray's *Fuzzing RLVR
  Verifiers* (arXiv 2606.01066) established that verifier defects can be found
  before training, with an eleven-class taxonomy. ABA (arXiv 2605.26079)
  established the structured-findings schema for benchmark auditing.

So this is **not** a research contribution. It is tooling built against a
published taxonomy and a published schema — the earlier research memos in
[`docs/research/`](docs/research/) trace how this project arrived here, from a
prediction-market acceptance layer that did not survive contact with the
literature (see [`docs/research/03-CONVERGENCE.md`](docs/research/03-CONVERGENCE.md)).

## The design decision that carries it

Every suite must contain control probes. Without them a verifier that rejects
everything scores a perfect false-accept rate while being useless — and
over-strictness is not the safe direction, it is the failure mode that gets a
gate switched off. `validateSuite()` refuses a suite with no controls; both
rates are always reported. A verifier that exceeds its timeout is recorded as
*unresponsive*, which on an exploit probe counts as a defect rather than
infrastructure noise: failing to reject in bounded time is the exploitable
condition.

## Usage

```
genesis audit --suite <code|json|math|behavioral> [--ledger <db>] [--json] [--verbose]
              and exactly one of:
                --verifier "<cmd with {task_file} {completion_file}>"  (code/json/math)
                --oracle eve [--eve-bin "<cmd>"]                       (behavioral)
              [--name <label>] [--accept exit_zero|json_reward|json_pass]
              [--threshold <n>] [--timeout <ms>]

genesis suites    list probe suites and the defect classes they cover
```

`--ledger` is optional. An audit is useful as a one-shot check; it becomes
evidence only when someone needs to prove it happened — recorded in a
hash-chained, append-only, tamper-evident ledger (`src/ledger/`).

The `behavioral` suite judges against [EVE](https://github.com/fernandogarzaaa/experience-validation-engine)
(the Experience Validation Engine) rather than a `{task_file}`/`{completion_file}`
verifier command.

## Documents

- [`docs/assurance/README.md`](docs/assurance/README.md) — the taxonomy, the
  schema, and the full design rationale for this module.
- [`docs/research/`](docs/research/) — the memos that retired Genesis's
  original acceptance-layer thesis against the literature and redirected it
  here.
- [`docs/decisions/`](docs/decisions/) — architecture decision records.

## Related

- **[EVE](https://github.com/fernandogarzaaa/experience-validation-engine)** —
  Experience Validation Engine. The behavioral judge Genesis's `behavioral`
  suite audits against, consumed across a process boundary and deliberately
  kept separate.
- **[ADAM](https://github.com/fernandogarzaaa/adam)** — self-evolving organism
  runtime. Source of the hash-linked version chain and single-choke-point
  governance patterns the ledger adopts.
- **[AXIOM-AETHER](https://github.com/fernandogarzaaa/axiom-aether)** —
  local-first TTT and compression runtime. Prior art for calibrated trust gates.
