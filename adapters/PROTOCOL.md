# Genesis adapter protocol

How to point Genesis at an existing system **without rewriting it and without
an SDK**. Any executable that honors this contract is evaluable. The thin
`python/` and `node/` helper packages in this directory implement the other
side of the contract; they are conveniences, not requirements.

## Subjects (the system under test)

Invocation:

```text
<command with {task_file} and/or {input} substituted>
```

- `{task_file}` — path to a JSON file holding the task:
  `{id, input, context?, expected?, reference?, constraints?, metadata?, tags?, kind?}`.
  Also available as `GENESIS_TASK_FILE`.
- `{input}` — the task input inline (stringified when not a string).
- If the command contains neither placeholder, Genesis appends the task file
  path as the final argument.

Output contract (stdout):

- Plain text → the output is the text (trimmed).
- JSON object/array → parsed and used as structured output.
- Anything on stderr is captured for diagnosis and never treated as output.
- Non-zero exit → recorded as a subject error (not a failure verdict).
- Exceeding the timeout → recorded as a timed-out trial (not a failure verdict).

Secrets in stdout/stderr are redacted before storage. Never print tokens.

## Multi-turn subjects (conversation loop)

When a task carries `turns` (ordered prompts), Genesis invokes the subject
once per turn instead of once per task. Each invocation receives a task
file shaped like:

```json
{
  "id": "task-0001#turn2",
  "input": "<this turn's prompt>",
  "context": {
    "history": [
      { "role": "user", "content": "<turn 1 prompt>" },
      { "role": "assistant", "content": "<turn 1 reply>" },
      { "role": "user", "content": "<this turn's prompt>" }
    ],
    "turn": 2
  }
}
```

Note: `history` already ends with the current prompt (the runner appends
it before invoking the subject), which also arrives separately as `input`.
Answer from `input`; use `history` for prior-turn context only — do not
process the trailing prompt twice.

Turn output contract (stdout), same envelope as single-shot plus an
optional stop signal:

- Plain text or JSON → the turn's assistant message.
- `{"message": "...", "done": true}` → message recorded, loop stops early.
- `spec.max_turns` caps iterations; the loop also stops at the last turn.

The evaluator judges the **final** message; the full transcript is
preserved on the trial as evidence (`transcript` field in results.jsonl).
`mean_turns` measures loop length. Subjects that cannot converse should
omit turn handling — single-shot tasks never enter the loop.

## Evaluators (external judges: `command`, `oracle`, `llm_command`)

Invocation:

```text
<command with {task_file} and {output_file} substituted>
```

- `{task_file}` — the task JSON (as above).
- `{output_file}` — the subject output: raw text, or JSON when the output was
  structured. Also available as `GENESIS_OUTPUT_FILE`.

Output contract (stdout) for `command` / `llm_command`:

```json
{ "passed": true }
{ "score": 0.83 }
{ "passed": false, "score": 0.2, "faithfulness": 0.9 }
```

- `passed` (boolean) decides trial success; `score` (number) feeds metrics.
- Extra numeric fields (e.g. `faithfulness`) are aggregatable via
  `detail:<field>` metrics.
- stdout may contain surrounding log noise: Genesis extracts the JSON object.
- Unparseable stdout, or neither `passed` nor `score` present → the trial is
  **unjudged** (null), which forces INCONCLUSIVE rather than a false verdict.

For `oracle`, only the exit code matters: zero means pass.

For `llm_command`, also record the judge model in the spec (`model:`) — the
judge stays evaluable and never becomes ground truth.

## Minimal examples

Python subject (`adapters/python`):

```python
from genesis_adapter import run_subject

def solve(task):
    n = int(task["input"])
    return str(n * 2)

if __name__ == "__main__":
    run_subject(solve)
```

Node evaluator (`adapters/node`):

```js
import { runEvaluator } from "../../adapters/node/index.js";

await runEvaluator((task, output) => ({
  passed: Number(output) === 2 * Number(task.input),
}));
```

```yaml
subject:
  command: "python ./agent.py {task_file}"
evaluator:
  type: command
  command: "node ./judge.mjs {task_file} {output_file}"
```
