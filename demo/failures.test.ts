import { describe, expect, test } from "bun:test";
import { add } from "../src/math.ts";

/**
 * Three different failure kinds — assertion diff, thrown error, and test
 * timeout — all rendered in ONE compact report:
 *
 *   bun run runner/run-test.ts --plain demo/failures.test.ts
 */
describe("failure demo", () => {
  test("assertion diff failure", () => {
    expect(add(2, 2)).toBe(5);
  });

  test("thrown error failure", () => {
    throw new Error("boom: something went wrong on purpose");
  });

  test("timeout failure", async () => {
    await Bun.sleep(10_000);
  }, 500);
});
