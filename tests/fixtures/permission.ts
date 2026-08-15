import {
  OPERATION_BINDING_VERSION,
  type OperationBinding,
} from "../../src/policy/permission-contracts.js";

export function binding(overrides: Partial<OperationBinding> = {}): OperationBinding {
  return {
    bindingVersion: OPERATION_BINDING_VERSION,
    sessionId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    authorizationVersion: "authorization:v1",
    toolName: "commit_push_create_pr",
    toolVersion: "tool:v1",
    inputSchemaHash: hash("a"),
    normalizationVersion: "normalization:v1",
    effectiveInputHash: hash("1"),
    workspaceId: "33333333-3333-4333-8333-333333333333",
    codeVersion: "git:abc123",
    diffHash: hash("2"),
    configVersion: "config:v1",
    ...overrides,
  };
}

export function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
