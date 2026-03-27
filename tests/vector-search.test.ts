import { expect, test } from "bun:test";
import { roundToTwoDecimals } from "../lib/generator";
import {
  createMatchSample,
  createMatchSampleWithPairCount,
} from "../lib/match-sample";
import {
  VECTOR_DISTANCE_WEIGHTS,
  canonicalizeRawVecStructure,
  canonicalizeVector,
  getVectorDistance,
} from "../lib/vector-search";

test("canonicalizeVector normalizes by Euclidean magnitude", () => {
  const weightedRatio = 3 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.ratio);
  const weightedAngle = 4 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.angle);
  const weightedZ = 1 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.z);
  const magnitude = Math.hypot(weightedRatio, weightedAngle, weightedZ);

  expect(canonicalizeVector([3, 4, 1])).toEqual([
    weightedRatio / magnitude,
    weightedAngle / magnitude,
    weightedZ / magnitude,
  ]);
});

test("getVectorDistance treats identical vectors as zero distance", () => {
  expect(getVectorDistance([1, 2, 3], [1, 2, 3])).toBe(0);
});

test("getVectorDistance only matches equal-length vectors", () => {
  expect(getVectorDistance([1, 0], [1, 0, 0])).toBe(Number.POSITIVE_INFINITY);
});

test("canonicalizeRawVecStructure reorders pairs and points by CCW sweep", () => {
  expect(canonicalizeRawVecStructure([1, 1, 1, -1, 0, 2, 0, -2, 1])).toEqual([
    1, 0, 0, 2, 1, 3, 0, 5.283185307179586, 1,
  ]);
});

test("canonicalizeRawVecStructure prefers a z=0 sweep before a z=1 sweep", () => {
  expect(
    canonicalizeRawVecStructure([
      1,
      0,
      1,
      1,
      1,
      Math.PI,
      0,
      (3 * Math.PI) / 2,
      0,
    ]),
  ).toEqual([
    1,
    0,
    0,
    1.5707963267948966,
    0,
    3.141592653589793,
    1,
    4.141592653589793,
    1,
  ]);
});

test("getVectorDistance is invariant to pair and point ordering", () => {
  const leftVector = [1, 1, 1, -1, 0, 2, 0, -2, 1];
  const rightVector = [1, 2.1, 0, -1.9, 1, 1.1, 1, -0.9, 0];

  expect(getVectorDistance(leftVector, rightVector)).toBe(0);
});

test("getVectorDistance stays small under mild angle noise that preserves sweep order", () => {
  const baseVector = [1, -2.6, 0, -1.4, 1, 0.2, 1, 1.8, 0];
  const noisyVector = [1, -2.55, 0, -1.35, 1, 0.18, 1, 1.83, 0];

  expect(getVectorDistance(baseVector, noisyVector)).toBeLessThan(0.05);
});

test("createMatchSampleWithPairCount returns a sample with the requested number of pairs", () => {
  expect(createMatchSampleWithPairCount(1_000_001, 4).portPoints).toHaveLength(
    8,
  );
});

test("createMatchSample keeps generated samples within a 4:1 aspect ratio", () => {
  for (let sampleIndex = 1_000_001; sampleIndex < 1_000_101; sampleIndex += 1) {
    const sample = createMatchSample(sampleIndex);
    const aspectRatio = Math.max(
      sample.width / sample.height,
      sample.height / sample.width,
    );

    expect(aspectRatio).toBeLessThanOrEqual(4);
  }
});

test("createMatchSample keeps generated port points within declared bounds", () => {
  for (let sampleIndex = 1_000_001; sampleIndex < 1_000_101; sampleIndex += 1) {
    const sample = createMatchSample(sampleIndex);
    const minX = roundToTwoDecimals(sample.center.x - sample.width / 2);
    const maxX = roundToTwoDecimals(sample.center.x + sample.width / 2);
    const minY = roundToTwoDecimals(sample.center.y - sample.height / 2);
    const maxY = roundToTwoDecimals(sample.center.y + sample.height / 2);

    for (const portPoint of sample.portPoints) {
      expect(portPoint.x).toBeGreaterThanOrEqual(minX);
      expect(portPoint.x).toBeLessThanOrEqual(maxX);
      expect(portPoint.y).toBeGreaterThanOrEqual(minY);
      expect(portPoint.y).toBeLessThanOrEqual(maxY);
    }
  }
});
