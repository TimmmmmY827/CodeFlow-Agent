# Security

## Current support boundary

CodeFlow Agent is a personal Windows prototype. Commands execute as the current Windows user. Workspace checks, approvals, timeouts and cancellation reduce risk but do not form a strong sandbox.

Do not use the MVP on untrusted repositories or for untrusted users. Container or stronger isolation is required before that scope is accepted.

## Security invariants

- No access outside the authorized workspace without explicit user action.
- No secret, credential, raw reasoning or unauthorized source code in normal trace export.
- No file deletion, dependency installation, commit, push or PR creation without the configured confirmation.
- No force push, destructive Git reset, elevation or system configuration changes.
- Stop new calls after cancellation and terminate controllable child processes within the defined deadline.
- Never hide or fabricate verification results.

## Reporting

Until the repository is made public, report security issues directly to the repository owner through a private GitHub channel. Do not open a public issue containing credentials or exploit details.
