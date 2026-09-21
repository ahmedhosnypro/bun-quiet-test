import { describe, expect, test } from "bun:test";

/**
 * Slow, passing tests — run the demo suite in a terminal and watch the live TUI
 * for ~5 seconds as the stats tick up:
 *
 *   bun run demo
 */
describe("slow demo", () => {
  test("boots the service", async () => {
    await Bun.sleep(1_000);
    expect(true).toBe(true);
  });

  test("processes a batch", async () => {
    console.log("noise: console output from tests is dropped by the wrapper");
    await Bun.sleep(2_000);
    expect([1, 2, 3]).toHaveLength(3);
  });

  test("flushes pending work", async () => {
    await Bun.sleep(2_000);
    expect("done").toBe("done");
  });
});
