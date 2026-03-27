import {
  DEFAULT_DATASET_SEED,
  MAX_NODE_ASPECT_RATIO,
  createDeterministicRandom,
  generateNodeWithPortPoints,
  getSampleSeed,
  roundToTwoDecimals,
} from "./generator";
import type { DatasetSample } from "./types";

export const MATCH_DATASET_SEED = DEFAULT_DATASET_SEED ^ 0x5f37_1c2b;
const MATCH_STRETCH_SEED = MATCH_DATASET_SEED ^ 0x31a4_b29d;
const MAX_MATCH_SAMPLE_SEARCH_ATTEMPTS = 1_024;
const MIN_MATCH_STRETCH_FACTOR = 1.8;
const MATCH_STRETCH_RANGE = 1.6;

const getMaxStretchFactor = (
  baseSample: Pick<DatasetSample, "width" | "height">,
  stretchWidth: boolean,
) => {
  if (stretchWidth) {
    return (MAX_NODE_ASPECT_RATIO * baseSample.height) / baseSample.width;
  }

  return (MAX_NODE_ASPECT_RATIO * baseSample.width) / baseSample.height;
};

export const createMatchSample = (sampleIndex: number): DatasetSample => {
  const baseSample = generateNodeWithPortPoints(
    sampleIndex,
    MATCH_DATASET_SEED,
  );
  const random = createDeterministicRandom(
    getSampleSeed(sampleIndex, MATCH_STRETCH_SEED),
  );
  const stretchWidth = random() >= 0.5;
  const desiredStretchFactor =
    MIN_MATCH_STRETCH_FACTOR + random() * MATCH_STRETCH_RANGE;
  const stretchFactor = Math.max(
    1,
    Math.min(
      desiredStretchFactor,
      getMaxStretchFactor(baseSample, stretchWidth),
    ),
  );
  const maxWidth = roundToTwoDecimals(
    baseSample.height * MAX_NODE_ASPECT_RATIO,
  );
  const maxHeight = roundToTwoDecimals(
    baseSample.width * MAX_NODE_ASPECT_RATIO,
  );
  const width = roundToTwoDecimals(
    stretchWidth
      ? Math.min(baseSample.width * stretchFactor, maxWidth)
      : baseSample.width,
  );
  const height = roundToTwoDecimals(
    stretchWidth
      ? baseSample.height
      : Math.min(baseSample.height * stretchFactor, maxHeight),
  );
  const widthScale = width / baseSample.width;
  const heightScale = height / baseSample.height;

  return {
    ...baseSample,
    capacityMeshNodeId: `match-${sampleIndex.toString().padStart(6, "0")}`,
    width,
    height,
    solvable: false,
    solution: null,
    portPoints: baseSample.portPoints.map((portPoint) => ({
      ...portPoint,
      x: roundToTwoDecimals(
        baseSample.center.x + (portPoint.x - baseSample.center.x) * widthScale,
      ),
      y: roundToTwoDecimals(
        baseSample.center.y + (portPoint.y - baseSample.center.y) * heightScale,
      ),
    })),
  };
};

export const createMatchSampleWithPairCount = (
  sampleIndex: number,
  pairCount: number,
): DatasetSample => {
  const targetPortPointCount = pairCount * 2;

  if (!Number.isInteger(pairCount) || pairCount <= 0) {
    throw new Error(`pairCount must be a positive integer, got ${pairCount}`);
  }

  for (let offset = 0; offset < MAX_MATCH_SAMPLE_SEARCH_ATTEMPTS; offset += 1) {
    const candidate = createMatchSample(sampleIndex + offset);
    if (candidate.portPoints.length === targetPortPointCount) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to generate a ${targetPortPointCount}-port-point (${pairCount}-pair) match sample near ${sampleIndex}`,
  );
};

export const resizeSampleToDimensions = (
  sample: DatasetSample,
  width: number,
  height: number,
): DatasetSample => {
  const widthScale = width / sample.width;
  const heightScale = height / sample.height;

  return {
    ...sample,
    width: roundToTwoDecimals(width),
    height: roundToTwoDecimals(height),
    portPoints: sample.portPoints.map((portPoint) => ({
      ...portPoint,
      x: roundToTwoDecimals(
        sample.center.x + (portPoint.x - sample.center.x) * widthScale,
      ),
      y: roundToTwoDecimals(
        sample.center.y + (portPoint.y - sample.center.y) * heightScale,
      ),
    })),
  };
};
