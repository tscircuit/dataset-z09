import { expect, test } from "bun:test";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import { canonicalizeVector, getVectorDistance } from "../lib/vector-search";

test("canonicalizeVector normalizes by Euclidean magnitude", () => {
  expect(canonicalizeVector([3, 4, 1])).toEqual([
    30 / Math.hypot(30, 4, 10),
    4 / Math.hypot(30, 4, 10),
    10 / Math.hypot(30, 4, 10),
  ]);
});

test("getVectorDistance treats identical vectors as zero distance", () => {
  expect(getVectorDistance([1, 2, 3], [1, 2, 3])).toBe(0);
});

test("getVectorDistance only matches equal-length vectors", () => {
  expect(getVectorDistance([1, 0], [1, 0, 0])).toBe(Number.POSITIVE_INFINITY);
});

test("createMatchSampleWithPairCount returns a sample with the requested number of pairs", () => {
  expect(createMatchSampleWithPairCount(1_000_001, 4).portPoints).toHaveLength(
    8,
  );
});
