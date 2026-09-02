import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceCodeSnapshotProvider } from "../src/completion/code-snapshot-provider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("WorkspaceCodeSnapshotProvider", () => {
  it("binds Git HEAD and detects tracked and untracked content changes", async () => {
    const workspace = await temporaryDirectory();
    git(workspace, "init");
    git(workspace, "config", "user.email", "codeflow@example.invalid");
    git(workspace, "config", "user.name", "CodeFlow Test");
    await writeFile(path.join(workspace, "tracked.txt"), "initial\n", "utf8");
    git(workspace, "add", "tracked.txt");
    git(workspace, "commit", "-m", "initial");
    const provider = new WorkspaceCodeSnapshotProvider();

    const clean = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, "tracked.txt"), "changed\n", "utf8");
    const trackedChange = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, "untracked.txt"), "first\n", "utf8");
    const untrackedFirst = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, "untracked.txt"), "second\n", "utf8");
    const untrackedSecond = await provider.capture(workspace, "config:test");

    expect(clean.codeVersion).toMatch(/^git:[0-9a-f]{40,64}$/);
    expect(new Set([clean.diffHash, trackedChange.diffHash, untrackedFirst.diffHash, untrackedSecond.diffHash]).size).toBe(4);
    expect(clean.configVersion).toBe("config:test");
    expect(clean.workspacePath).toBe(await realpath(workspace));
  });

  it("excludes private .codeflow data at a repository root and a scoped workspace", async () => {
    const repository = await temporaryDirectory();
    const workspace = path.join(repository, "packages", "app");
    await mkdir(workspace, { recursive: true });
    git(repository, "init");
    const provider = new WorkspaceCodeSnapshotProvider();
    const before = await provider.capture(workspace, "config:test");

    await mkdir(path.join(workspace, ".codeflow"), { recursive: true });
    await writeFile(path.join(workspace, ".codeflow", "codeflow.sqlite"), "private-state-1", "utf8");
    const afterFirstWrite = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, ".codeflow", "codeflow.sqlite"), "private-state-2", "utf8");
    const afterSecondWrite = await provider.capture(workspace, "config:test");

    expect(afterFirstWrite).toEqual(before);
    expect(afterSecondWrite).toEqual(before);
  });

  it("supports an unborn Git repository without inventing a commit", async () => {
    const workspace = await temporaryDirectory();
    git(workspace, "init");
    await writeFile(path.join(workspace, "README.md"), "first\n", "utf8");
    const provider = new WorkspaceCodeSnapshotProvider();

    const first = await provider.capture(workspace, "config:test");
    git(workspace, "add", "README.md");
    const staged = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, "README.md"), "second\n", "utf8");
    const second = await provider.capture(workspace, "config:test");

    expect(first.codeVersion).toMatch(/^git:unborn-[0-9a-f]{64}$/);
    expect(second.codeVersion).toBe(first.codeVersion);
    expect(new Set([first.diffHash, staged.diffHash, second.diffHash]).size).toBe(3);
  });

  it("creates deterministic content snapshots for plain and empty workspaces", async () => {
    const workspace = await temporaryDirectory();
    const provider = new WorkspaceCodeSnapshotProvider();

    const empty = await provider.capture(workspace, "config:test");
    const repeated = await provider.capture(workspace, "config:test");
    await writeFile(path.join(workspace, "main.ts"), "export {};\n", "utf8");
    const populated = await provider.capture(workspace, "config:test");

    expect(repeated).toEqual(empty);
    expect(empty.codeVersion).toMatch(/^workspace:[0-9a-f]{64}$/);
    expect(populated.codeVersion).toBe(empty.codeVersion);
    expect(populated.diffHash).not.toBe(empty.diffHash);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codeflow-completion-snapshot-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspace,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}
