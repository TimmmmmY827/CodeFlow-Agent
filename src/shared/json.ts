import { err, ok, type Result } from "./result.js";

export type JsonPrimitive = boolean | number | string | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export interface JsonValidationError {
  readonly category: "not_json_serializable";
  readonly message: string;
  readonly path: string;
  readonly retryable: false;
  readonly sideEffectStatus: "none";
  readonly recovery: null;
}

export function validateJsonValue(value: unknown): Result<JsonValue, JsonValidationError> {
  const activeObjects = new WeakSet<object>();
  const failure = findJsonFailure(value, "$", activeObjects);
  return failure ? err(failure) : ok(value as JsonValue);
}

export function isJsonValue(value: unknown): value is JsonValue {
  return validateJsonValue(value).ok;
}

export function canonicalJson(value: unknown): string {
  const validated = validateJsonValue(value);
  if (!validated.ok) {
    throw new TypeError(`${validated.error.message} at ${validated.error.path}`);
  }
  return JSON.stringify(canonicalize(validated.value));
}

function findJsonFailure(
  value: unknown,
  path: string,
  activeObjects: WeakSet<object>,
): JsonValidationError | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : jsonFailure("JSON numbers must be finite.", path);
  }
  if (typeof value !== "object") {
    return jsonFailure(`Values of type ${typeof value} are not JSON serializable.`, path);
  }
  if (activeObjects.has(value)) return jsonFailure("Cyclic values are not JSON serializable.", path);

  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = findJsonFailure(value[index], `${path}[${index}]`, activeObjects);
        if (failure) return failure;
      }
      return null;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      return jsonFailure("Only plain objects can cross persistence boundaries.", path);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        return jsonFailure("Symbol keys are not JSON serializable.", path);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return jsonFailure("Non-enumerable properties and accessors are not JSON serializable.", propertyPath(path, key));
      }
      const failure = findJsonFailure(descriptor.value, propertyPath(path, key), activeObjects);
      if (failure) return failure;
    }
    return null;
  } finally {
    activeObjects.delete(value);
  }
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const objectValue = value as JsonObject;
    return Object.fromEntries(
      Object.keys(objectValue)
        .sort(compareCodeUnits)
        .map((key) => [key, canonicalize(objectValue[key] as JsonValue)]),
    );
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function jsonFailure(message: string, path: string): JsonValidationError {
  return {
    category: "not_json_serializable",
    message,
    path,
    retryable: false,
    sideEffectStatus: "none",
    recovery: null,
  };
}
