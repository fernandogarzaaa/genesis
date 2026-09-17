# Genesis plugins — use Genesis inside AI platforms

| Platform | Install | Contents |
|---|---|---|
| Claude Code | Add this repo as a marketplace, then `/plugin install genesis` (`/.claude-plugin/marketplace.json` → `plugins/genesis/`: plugin manifest, `genesis` skill, auto-registered MCP server via `.mcp.json`) | `plugins/genesis/` |
| opencode | Copy `plugins/opencode/skills/genesis/` to `~/.config/opencode/skills/` (or `.opencode/skills/`); merge `opencode-mcp.jsonc` into `opencode.json`; restart opencode | `plugins/opencode/` |
| Codex CLI | Add the `[mcp_servers.genesis]` block to `config.toml`; optional AGENTS.md agreement | `plugins/codex/` |
| Hermes / any MCP client | Spawn the stdio server (JSON below) | `plugins/hermes/` |

## MCP server

```bash
genesis mcp   # stdio; 9 tools: evaluate, audit_evaluator, trust,
              # list_benchmarks, run_benchmark, compare_runs,
              # check_regression, read_report, show_claim
```

Remote clients use `npx -y genesis-assurance@latest mcp` (available after
first `npm publish`; until then use the local `node …/dist/cli/run.js mcp`
form documented in each platform folder). Requires Node ≥ 20. Subjects run
as local commands with the invoking user's privileges — same trust model as
running the CLI yourself.

## Notes

- Skills follow the Agent Skills `SKILL.md` format; the `genesis` skill is
  identical for Claude Code and opencode by design (one contract, two loaders).
- The `.mcp.json` in the Claude plugin and every platform snippet point at
  the published package name; pre-publish alternatives are in each folder.
