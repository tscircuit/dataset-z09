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
  const weightedAngle = 0;
  const weightedZ = 1 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.z);
  const weightedX = 2 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.distWeight);
  const weightedY = 5 * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.distWeight);
  const magnitude = Math.hypot(
    weightedRatio,
    weightedAngle,
    weightedZ,
    weightedX,
    weightedY,
  );

  expect(canonicalizeVector([3, 4, 1, 2, 5])).toEqual([
    weightedRatio / magnitude,
    weightedAngle / magnitude,
    weightedZ / magnitude,
    weightedX / magnitude,
    weightedY / magnitude,
  ]);
});

test("getVectorDistance treats identical vectors as zero distance", () => {
  expect(getVectorDistance([1, 0, 0, 1, 0], [1, 0, 0, 1, 0])).toBe(0);
});

test("getVectorDistance only matches equal-length vectors", () => {
  expect(getVectorDistance([1, 0], [1, 0, 0, 0, 0])).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("canonicalizeRawVecStructure reorders pairs and points while preserving absolute orientation", () => {
  expect(
    canonicalizeRawVecStructure([
      1,
      Math.PI / 2,
      1,
      0,
      1,
      (3 * Math.PI) / 2,
      0,
      0,
      -1,
      0,
      0,
      1,
      0,
      Math.PI,
      1,
      -1,
      0,
    ]),
  ).toEqual([
    1,
    0,
    0,
    1,
    0,
    Math.PI,
    1,
    -1,
    0,
    (3 * Math.PI) / 2,
    0,
    0,
    -1,
    Math.PI / 2,
    1,
    0,
    1,
  ]);
});

test("canonicalizeRawVecStructure preserves the new topology header", () => {
  expect(
    canonicalizeRawVecStructure([
      1,
      7,
      8,
      9,
      Math.PI / 2,
      1,
      0,
      1,
      (3 * Math.PI) / 2,
      0,
      0,
      -1,
      0,
      0,
      1,
      0,
      Math.PI,
      1,
      -1,
      0,
    ]),
  ).toEqual([
    1,
    7,
    8,
    9,
    0,
    0,
    1,
    0,
    Math.PI,
    1,
    -1,
    0,
    (3 * Math.PI) / 2,
    0,
    0,
    -1,
    Math.PI / 2,
    1,
    0,
    1,
  ]);
});

test("canonicalizeRawVecStructure prefers a z=0 sweep before a z=1 sweep", () => {
  expect(
    canonicalizeRawVecStructure([
      1,
      0,
      1,
      1,
      0,
      Math.PI / 2,
      1,
      0,
      1,
      Math.PI,
      0,
      -1,
      0,
      (3 * Math.PI) / 2,
      0,
      0,
      -1,
    ]),
  ).toEqual([
    1,
    Math.PI,
    0,
    -1,
    0,
    (3 * Math.PI) / 2,
    0,
    0,
    -1,
    0,
    1,
    1,
    0,
    Math.PI / 2,
    1,
    0,
    1,
  ]);
});

test("getVectorDistance is invariant to pair and point ordering", () => {
  const leftVector = [
    1,
    0,
    0,
    1,
    0,
    Math.PI,
    1,
    -1,
    0,
    (3 * Math.PI) / 2,
    0,
    0,
    -1,
    Math.PI / 2,
    1,
    0,
    1,
  ];
  const rightVector = [
    1,
    Math.PI,
    1,
    -1,
    0,
    0,
    0,
    1,
    0,
    Math.PI / 2,
    1,
    0,
    1,
    (3 * Math.PI) / 2,
    0,
    0,
    -1,
  ];

  expect(getVectorDistance(leftVector, rightVector)).toBe(0);
});

test("getVectorDistance stays small under mild geometric noise that preserves sweep order", () => {
  const baseVector = [
    1,
    -2.6,
    0,
    -0.9,
    -1,
    -1.4,
    1,
    0.2,
    -1,
    0.2,
    1,
    0.9,
    0.2,
    1.8,
    0,
    -0.2,
    1,
  ];
  const noisyVector = [
    1,
    -2.55,
    0,
    -0.88,
    -1,
    -1.35,
    1,
    0.18,
    -1,
    0.18,
    1,
    0.92,
    0.22,
    1.83,
    0,
    -0.18,
    1,
  ];

  expect(getVectorDistance(baseVector, noisyVector)).toBeLessThan(0.05);
});

test("getVectorDistance no longer collapses globally rotated vectors to zero", () => {
  const leftVector = [
    2,
    0,
    0,
    1,
    0,
    Math.PI / 2,
    0,
    0,
    1,
    Math.PI,
    1,
    -1,
    0,
    -Math.PI / 2,
    1,
    0,
    -1,
  ];
  const rightVector = [
    2,
    Math.PI / 4,
    0,
    Math.SQRT1_2,
    Math.SQRT1_2,
    (3 * Math.PI) / 4,
    0,
    -Math.SQRT1_2,
    Math.SQRT1_2,
    (-3 * Math.PI) / 4,
    1,
    -Math.SQRT1_2,
    -Math.SQRT1_2,
    -Math.PI / 4,
    1,
    Math.SQRT1_2,
    -Math.SQRT1_2,
  ];

  expect(getVectorDistance(leftVector, rightVector)).toBeGreaterThan(0.1);
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
