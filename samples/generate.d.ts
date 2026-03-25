import type { NodeWithPortPoints } from "../lib/types";

export { DEFAULT_DATASET_SEED } from "../lib/generator";

export declare const generateNodeWithPortPoints: (
  sampleIndex: number,
  datasetSeed?: number,
) => NodeWithPortPoints;

export declare const generateSampleNode: (
  sampleIndex: number,
  datasetSeed?: number,
) => NodeWithPortPoints;

export default generateSampleNode;
