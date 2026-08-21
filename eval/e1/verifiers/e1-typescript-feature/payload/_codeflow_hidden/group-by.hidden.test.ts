import assert from "node:assert/strict";
import test from "node:test";

import { groupBy } from "../src/group-by.ts";

test("groups values and preserves input/group order", () => {
  const input = Object.freeze([
    Object.freeze({ id: 1, team: "blue" }),
    Object.freeze({ id: 2, team: "red" }),
    Object.freeze({ id: 3, team: "blue" }),
  ]);
  const grouped = groupBy(input, (item) => item.team);
  assert.deepEqual(grouped.blue.map((item) => item.id), [1, 3]);
  assert.deepEqual(grouped.red.map((item) => item.id), [2]);
  assert.deepEqual(input.map((item) => item.id), [1, 2, 3]);
});

test("handles empty input and prototype-like keys safely", () => {
  assert.deepEqual(Object.keys(groupBy([], String)), []);
  const grouped = groupBy(["__proto__", "constructor"], (item) => item);
  assert.equal(Object.hasOwn(grouped, "__proto__"), true);
  assert.deepEqual(grouped.__proto__, ["__proto__"]);
  assert.deepEqual(grouped.constructor, ["constructor"]);
});
