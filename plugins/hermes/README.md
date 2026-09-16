# Genesis for Hermes Agent (and any MCP-compatible client)

Genesis serves 9 tools over MCP stdio. Any client that can spawn a stdio
MCP server can use it with this launch description:

```json
{
  "command": "npx",
  "args": ["-y", "genesis-assurance@latest", "mcp"]
}
```

Local checkout alternative:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/genesis/dist/cli/run.js", "mcp"]
}
```

Tools: `evaluate`, `audit_evaluator`, `trust`, `list_benchmarks`,
`run_benchmark`, `compare_runs`, `check_regression`, `read_report`,
`show_claim`. Long evaluations can exceed client timeouts — prefer small
specs interactively and run large suites via the CLI (`genesis evaluate`,
`genesis trust`, `genesis run-benchmark`).
