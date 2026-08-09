# Contributing

CodeFlow Agent is currently a personal MVP. Small, reviewable changes are preferred.

## Development

1. Use the Node.js version declared in `package.json` and pnpm.
2. Keep provider-specific code behind internal interfaces.
3. Add or update deterministic tests for behavior changes.
4. Run `pnpm check` before committing.
5. Document architectural decisions that change trust, persistence, or module boundaries.

Do not add automatic external writes, raw reasoning display, telemetry, long-term memory, RAG, MCP servers, or multi-agent behavior without an accepted decision record and evidence that the MVP baseline needs it.
