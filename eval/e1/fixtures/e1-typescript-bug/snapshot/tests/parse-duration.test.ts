import assert from "node:assert/strict";
import test from "node:test";

import { parseDuration } from "../src/parse-duration.ts";

test("parses minute durations", () => {
  assert.equal(parseDuration("2m"), 120_000);
});
