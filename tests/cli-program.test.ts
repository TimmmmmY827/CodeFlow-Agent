import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli/program.js";

describe("CLI run admission", () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("rejects a missing goal before creating a Session", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "codeflow", "run", "."]);

    expect(process.exitCode).toBe(2);
    expect(diagnostic).toHaveBeenCalledWith("codeflow run requires --prompt <goal>.");
  });

  it("rejects a missing DeepSeek credential before starting storage or network work", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "codeflow", "run", ".", "--prompt", "Inspect"]);

    expect(process.exitCode).toBe(2);
    expect(diagnostic).toHaveBeenCalledWith("DEEPSEEK_API_KEY is required for codeflow run.");
  });
});
