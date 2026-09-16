# Genesis for Codex

## MCP server

Add to `~/.codex/config.toml` (user scope) or `.codex/config.toml` (project
scope, Codex CLI reads both):

```toml
[mcp_servers.genesis]
command = "npx"
args = ["-y", "genesis-assurance@latest", "mcp"]
```

Pre-publish / pinned local alternative:

```toml
[mcp_servers.genesis]
command = "node"
args = ["/absolute/path/to/genesis/dist/cli/run.js", "mcp"]
```

Restart the Codex CLI after editing config. Verify with a prompt like
"list your MCP tools" — `evaluate`, `trust`, `run_benchmark` should appear.

## Working agreement (paste into AGENTS.md)

```markdown
## Evaluation (Genesis)

When asked to evaluate an AI system, judge, benchmark, or gate a release,
use the Genesis MCP tools (`evaluate`, `audit_evaluator`, `trust`,
`run_benchmark`, `check_regression`) — do not hand-roll scoring scripts.

- `trust` > `evaluate` for acted-on conclusions.
- Assure custom judges before promoting LLM-judged results.
- Verdicts: SUPPORTED/FALSIFIED/INCONCLUSIVE (+ evaluator
  SOUND/EXPLOITABLE/UNRELIABLE/OVER_STRICT). INCONCLUSIVE is legitimate.
- Link evidence bundles; never report scores from memory.
```
