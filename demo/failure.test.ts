import { describe, expect, test } from "bun:test";
import { add } from "../src/math.ts";

/**
 * Deliberately failing test — intentionally outside the default `test/` path.
 * Run it to see the wrapper's compact failure report:
 *
 *   bun run runner/run-test.ts demo/failure.test.ts
 */
describe("failure demo", () => {
  test("intentionally fails to show the compact error report", () => {
    expect(add(2, 2)).toBe(5);
  });
});
