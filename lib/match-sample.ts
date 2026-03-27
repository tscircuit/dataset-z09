import {
  DEFAULT_DATASET_SEED,
  createDeterministicRandom,
  generateNodeWithPortPoints,
  getSampleSeed,
  roundToTwoDecimals,
} from "./generator";
import type { DatasetSample } from "./types";

export const MATCH_DATASET_SEED = DEFAULT_DATASET_SEED ^ 0x5f37_1c2b;
const MATCH_STRETCH_SEED = MATCH_DATASET_SEED ^ 0x31a4_b29d;
const MAX_MATCH_SAMPLE_SEARCH_ATTEMPTS = 1_024;

export const createMatchSample = (sampleIndex: number): DatasetSample => {
  const baseSample = generateNodeWithPortPoints(
    sampleIndex,
    MATCH_DATASET_SEED,
  );
  const random = createDeterministicRandom(
    getSampleSeed(sampleIndex, MATCH_STRETCH_SEED),
  );
  const stretchWidth = random() >= 0.5;
  const stretchFactor = 1.8 + random() * 1.6;
  const width = roundToTwoDecimals(
    stretchWidth ? baseSample.width * stretchFactor : baseSample.width,
  );
  const height = roundToTwoDecimals(
    stretchWidth ? baseSample.height : baseSample.height * stretchFactor,
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
