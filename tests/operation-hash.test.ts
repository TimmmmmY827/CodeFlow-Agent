import { describe, expect, it } from "vitest";

import { createOperationHash } from "../src/policy/operation-hash.js";

describe("createOperationHash", () => {
  it("is stable across object key order but changes with code version", () => {
    const left = createOperationHash({
      toolName: "publish",
      input: { remote: "origin", branch: "agent/demo" },
      codeVersion: "git:a",
    });
    const reordered = createOperationHash({
      toolName: "publish",
      input: { branch: "agent/demo", remote: "origin" },
      codeVersion: "git:a",
    });
    const newer = createOperationHash({
      toolName: "publish",
      input: { branch: "agent/demo", remote: "origin" },
      codeVersion: "git:b",
    });

    expect(left).toBe(reordered);
    expect(newer).not.toBe(left);
  });

  it("rejects values that cannot cross the JSON boundary", () => {
    expect(() =>
      createOperationHash({
        toolName: "publish",
        input: { requestedAt: new Date("2026-08-09T00:00:00.000Z") },
        codeVersion: "git:a",
      }),
    ).toThrow(/plain objects/);
  });
});
