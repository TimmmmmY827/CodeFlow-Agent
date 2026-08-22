import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluationSuiteManifestSchema } from "../src/eval/evaluation.js";
import { E1FixtureHarness } from "../src/eval/fixture-harness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("E1 fixture harness", () => {
  it("validates the complete language/scenario matrix and bound artifact hashes", async () => {
    const manifest = await new E1FixtureHarness().validate();

    expect(manifest.tasks).toHaveLength(6);
    expect(new Set(manifest.tasks.map((task) => `${task.language}:${task.scenario}`))).toEqual(new Set([
      "typescript:existing-repository-bug",
      "typescript:new-project-feature",
      "python:existing-repository-bug",
      "python:new-project-feature",
      "go:existing-repository-bug",
      "go:new-project-feature",
    ]));
    expect(manifest.tasks.every((task) => task.networkPolicy === "deny" && task.hiddenVerifiers.length === 1)).toBe(true);
  });

  it("resets deterministic Git workspaces without exposing hidden verifier files", async () => {
    const root = await createTemporaryDirectory();
    const harness = new E1FixtureHarness();
    const first = await harness.reset("e1-typescript-bug", path.join(root, "first"));
    const second = await harness.reset("e1-typescript-bug", path.join(root, "second"));

    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.gitHead).toBe(second.gitHead);
    expect(await readFile(path.join(first.workspace, "src", "parse-duration.ts"), "utf8"))
      .toContain("const multiplier = unit === \"ms\" ? 1 : 1_000;");
    await expect(access(path.join(first.workspace, "_codeflow_hidden"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(first.workspace, "gold.patch"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an existing reset destination", async () => {
    const root = await createTemporaryDirectory();
    const harness = new E1FixtureHarness();
    const destination = path.join(root, "workspace");
    await harness.reset("e1-python-bug", destination);

    await expect(harness.reset("e1-python-bug", destination)).rejects.toThrow("already exists");
  });

  it("rejects candidate changes outside the task modification boundary before hidden tests run", async () => {
    const root = await createTemporaryDirectory();
    const harness = new E1FixtureHarness();
    const reset = await harness.reset("e1-typescript-bug", path.join(root, "workspace"));
    await writeFile(path.join(reset.workspace, "cheat.txt"), "out-of-scope\n", "utf8");

    await expect(harness.verify("e1-typescript-bug", reset.workspace)).resolves.toMatchObject({
      status: "failed",
      errorCategory: "modification_boundary_violated",
    });
  });

  it("proves TypeScript baselines and known bad patches fail while gold patches pass", async () => {
    const report = await new E1FixtureHarness().selfTest(["typescript"]);

    expect(report.passed).toBe(true);
    expect(report.items).toHaveLength(2);
    expect(report.items.every((item) => item.baselineRejected && item.goldPassed && item.badRejected)).toBe(true);
  });
});

describe("E1 manifest contract", () => {
  it("rejects path traversal and incomplete language/scenario matrices", async () => {
    const raw = JSON.parse(await readFile(path.join(process.cwd(), "eval", "e1", "manifest.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
    raw.tasks[0] = { ...raw.tasks[0], editablePaths: ["../hidden"] };
    raw.tasks.pop();

    const result = evaluationSuiteManifestSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "Expected a normalized relative path without traversal.",
        expect.stringContaining("Too small"),
      ]));
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "codeflow-e1-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
