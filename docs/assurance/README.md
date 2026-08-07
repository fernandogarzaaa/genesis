# Agent Assurance Core

**Audit the verifier, not the artifact.**

An RLVR verifier, an eval harness, or a benchmark grader is executable software,
and its bugs become rewardable failure modes. An agent optimizing against a
verifier with a hole will find the hole. This module fires adversarial probes at
a verifier and reports which defects it has.

```
$ genesis audit --suite code \
    --verifier "node harness.js {task_file} {completion_file}"

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

Exit codes: `0` SOUND · `1` EXPLOITABLE · `2` UNRELIABLE or OVER_STRICT ·
`3` Genesis itself failed.

## Why this exists

Two facts, from `docs/research/04-REDIRECTION-REVIEW.md`:

- **Environment defects are common.** Building SWE-bench Verified removed 68.3%
  of the original 2,294 instances as invalid. OpenAI later retired Verified after
  an internal audit found 59.4% of audited failed problems had flawed tests.
- **The research question is already answered.** Ray's *Fuzzing RLVR Verifiers*
  (arXiv 2606.01066) established that verifier defects can be found before
  training, with an eleven-class taxonomy. ABA (arXiv 2605.26079) established the
  structured-findings schema for benchmark auditing.

So this is **not** a research contribution. It is tooling built against a
published taxonomy and a published schema, on the premise that a ~60% defect rate
means the first harness you point it at will produce findings within a day.

## The taxonomy

Adopted verbatim from Ray rather than reinvented — eleven classes, three domains.

| Domain | Defect classes |
|---|---|
| **math** | loose answer extraction · missing markers · contradiction blindness · loose numeric tolerance |
| **json** | schema-only validation · ignored extra fields · duplicate key handling · embedded JSON parsing |
| **code** | visible-test overfitting · stdout spoofing · missing timeouts |

`genesis suites` lists them with the probes that cover each.

## The design decision that matters

**Every suite must contain control probes.**

An exploit probe is a completion that satisfies a defect but not the task; a
correct verifier rejects it. A control probe is a genuinely correct completion;
a correct verifier accepts it.

Without controls, a verifier that rejects everything scores a perfect zero
false-accept rate while being useless — and over-strictness is not the safe
direction, it is the failure mode that gets a gate switched off.
`validateSuite()` refuses to run a suite that has no controls, and the report
always shows both rates.

## Integrating a verifier

Genesis writes the task and the candidate completion to files and substitutes
their paths into your command:

```
--verifier "python grade.py --task {task_file} --completion {completion_file}"
```

`{task_file}` is JSON (prompt, reference, visible/hidden tests, schema);
`{completion_file}` is raw text. Read the verdict with `--accept`:

| `--accept` | Meaning |
|---|---|
| `exit_zero` | exit status 0 means accept |
| `json_reward` | parse stdout, threshold a numeric field (default `reward >= 1`) |
| `json_pass` | parse stdout, read a boolean field (default `pass`) |

A verifier that exceeds `--timeout` is recorded as **unresponsive**, which on an
exploit probe counts as a defect rather than an infrastructure error: failing to
reject in bounded time is the exploitable condition.

## What a verdict does and does not claim

`SOUND` means *no probe in this suite succeeded*. It bounds only the defect
classes the suite covers, and the report says so. It is not a claim of general
correctness, and a suite digest is recorded with every result precisely so that
"we audited it" always names which probes were fired.

## Verifying the auditor

`fixtures/verifiers/` contains two harnesses: `naive.mjs`, with every defect in
the taxonomy deliberately planted, and `strict.mjs`, written to resist them.
`tests/assurance.test.ts` runs both across all three suites and asserts that the
naive one is caught on every planted class **and** that the strict one clears
with zero false rejects.

A probe suite that flags everything is as useless as one that flags nothing.
Both directions are tested.

## Architecture

```
src/assurance/
  taxonomy.ts     the eleven defect classes
  probe.ts        probe and suite types, content hashing, suite validation
  suites/         code · json · math
  verifier.ts     subprocess adapter for the verifier under test
  audit.ts        the runner — impure, materializes ProbeResult[]
  findings.ts     PURE — metrics, findings, verdict
  report.ts       rendering
```

`findings.ts` is held to the same purity standard as the acceptance layer's
adjudicator, enforced by `tests/assurance.purity.test.ts`. The reason is sharper
here: this module's product is a claim about whether someone else's verifier can
be trusted, and a tool that cannot recompute its own conclusions is asking for
trust it will not extend to anyone else.

Reused from the acceptance layer: canonical hashing, the hash-chained ledger,
subprocess execution with secret redaction, and the Wilson intervals — per-class
probe counts are small, so a bare point estimate would mislead.

## Status

Working, tested, unproven in the field. The open question is not empirical but
commercial: whether anyone will run it against their own harness. Nothing in
this repository is evidence about that.
