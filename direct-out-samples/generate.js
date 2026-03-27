import {
  DEFAULT_DATASET_SEED,
  generateNodeWithPortPoints,
} from "../lib/generator.ts";

export { DEFAULT_DATASET_SEED, generateNodeWithPortPoints };

export const generateSampleNode = (
  sampleIndex,
  datasetSeed = DEFAULT_DATASET_SEED,
) => generateNodeWithPortPoints(sampleIndex, datasetSeed);

export default generateSampleNode;
