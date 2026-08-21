# E1 six-task fixture suite

This directory contains the first trusted evaluation slice for issue #7:

- TypeScript, Python, and Go.
- One existing-repository bug and one new-project feature per language.
- A versioned public task manifest with bound snapshot and verifier hashes.
- Hidden verifier payloads and gold/known-bad acceptance samples outside the Agent workspace.

## Commands

```powershell
pnpm eval:fixtures -- validate
pnpm eval:fixtures -- reset --task e1-typescript-bug --workspace C:\temp\codeflow-e1-task
pnpm eval:fixtures -- verify --task e1-typescript-bug --workspace C:\temp\codeflow-e1-task
pnpm eval:fixtures -- self-test
```

`reset` refuses to overwrite an existing path. It copies only the selected `snapshot/` and creates a deterministic Git commit. It never copies verifier or solution files into the task workspace.

`verify` copies the candidate into a separate temporary directory, checks the Git diff against the task's `editablePaths`, injects the bound hidden verifier there, and executes it with an allowlisted environment. Verifier output and source are not copied back to the task workspace.

`self-test` proves for all six tasks that the baseline fails, the gold patch passes, and a known-bad patch fails. Node 24, Python, Go, and Git must be available. CI installs the required runtimes explicitly.

## Security boundary

The suite declares `logical_workspace_boundary`, not a strong sandbox. The Agent receives only the reset workspace through CodeFlow's workspace-scoped tools. Hidden verifiers run after the Agent finishes. Fixtures and verifiers are trusted repository code; network access is denied by task policy and no verifier downloads dependencies.

The current slice does not implement the C15 evaluation runner, trace/evidence ingestion, OpenCode comparison, UX scoring, or release decision.
