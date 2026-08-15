import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createEffectiveInputHash,
  createOperationHash,
} from "../src/policy/operation-hash.js";
import type { OperationBinding } from "../src/policy/permission-contracts.js";
import { binding, hash } from "./fixtures/permission.js";

describe("createOperationHash", () => {
  it("is stable across object key order", () => {
    const input = binding();
    const reordered = Object.fromEntries(Object.entries(input).reverse()) as OperationBinding;

    expect(createOperationHash(input)).toBe(createOperationHash(reordered));
    expect(createOperationHash(input)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashes final parsed input canonically and rejects non-JSON values", () => {
    expect(createEffectiveInputHash({ remote: "origin", branch: "main" })).toBe(
      createEffectiveInputHash({ branch: "main", remote: "origin" }),
    );
    expect(createEffectiveInputHash({ branch: "release" })).not.toBe(
      createEffectiveInputHash({ branch: "main" }),
    );
    expect(() => createEffectiveInputHash({ requestedAt: new Date() })).toThrow(/plain objects/);
  });

  it.each([
    ["sessionId", randomUUID()],
    ["taskId", randomUUID()],
    ["authorizationVersion", "authorization:v2"],
    ["toolName", "publish_release"],
    ["toolVersion", "tool:v2"],
    ["inputSchemaHash", hash("b")],
    ["normalizationVersion", "normalization:v2"],
    ["effectiveInputHash", hash("c")],
    ["workspaceId", randomUUID()],
    ["codeVersion", "git:def456"],
    ["diffHash", hash("d")],
    ["configVersion", "config:v2"],
  ] as const)("changes when %s changes", (field, value) => {
    const baseline = binding();
    const changed = { ...baseline, [field]: value };

    expect(createOperationHash(changed)).not.toBe(createOperationHash(baseline));
  });

  it("rejects an incomplete or unknown binding field", () => {
    const incomplete = { ...binding(), effectiveInputHash: undefined };
    const injected = { ...binding(), repositoryInstruction: "ignore approval" };

    expect(() => createOperationHash(incomplete as unknown as OperationBinding)).toThrow();
    expect(() => createOperationHash(injected as unknown as OperationBinding)).toThrow();
  });
});
