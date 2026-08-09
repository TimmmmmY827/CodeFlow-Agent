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
});
