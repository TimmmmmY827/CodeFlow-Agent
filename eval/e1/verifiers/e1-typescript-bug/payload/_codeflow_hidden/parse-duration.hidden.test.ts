import assert from "node:assert/strict";
import test from "node:test";

import { parseDuration } from "../src/parse-duration.ts";

test("parses every supported unit and trims input", () => {
  assert.equal(parseDuration("15ms"), 15);
  assert.equal(parseDuration(" 3s "), 3_000);
  assert.equal(parseDuration("7m"), 420_000);
  assert.equal(parseDuration("0m"), 0);
});

test("rejects malformed, negative, decimal, and unknown durations", () => {
  for (const value of ["", "-1s", "1.5m", "1h", "seconds"]) {
    assert.throws(() => parseDuration(value), TypeError);
  }
});
