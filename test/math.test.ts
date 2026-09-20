import { describe, expect, test } from "bun:test";
import { add, average, subtract } from "../src/math.ts";

describe("add", () => {
  test("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  test("adds negative numbers", () => {
    expect(add(-2, -3)).toBe(-5);
  });

  test("is commutative", () => {
    expect(add(2, 3)).toBe(add(3, 2));
  });
});

describe("subtract", () => {
  test("subtracts the second from the first", () => {
    expect(subtract(10, 4)).toBe(6);
  });
});

describe("average", () => {
  test("averages a list of numbers", () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  test("throws on an empty list", () => {
    expect(() => average([])).toThrow("at least one value");
  });
});
