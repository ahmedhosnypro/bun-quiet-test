import { describe, expect, test } from "bun:test";
import { capitalize, slugify, truncate } from "../src/strings.ts";

describe("capitalize", () => {
  test("capitalizes a single word", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  test("lowercases the rest of the word", () => {
    expect(capitalize("hELLO")).toBe("Hello");
  });

  test("leaves an empty string alone", () => {
    expect(capitalize("")).toBe("");
  });
});

describe("truncate", () => {
  test("returns short strings unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });

  test("truncates long strings to maxLength - 1 plus an ellipsis", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  test("throws on a non-positive maxLength", () => {
    expect(() => truncate("hi", 0)).toThrow("positive");
  });
});

describe("slugify", () => {
  test("turns spaces into dashes", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  test("strips leading and trailing dashes", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });
});
