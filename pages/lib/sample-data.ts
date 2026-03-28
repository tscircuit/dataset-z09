import type { DatasetSample, HighDensityIntraNodeRoute } from "../../lib/types";

export type DatasetSampleRecord = DatasetSample & {
  solvedRoutes?: HighDensityIntraNodeRoute[] | null;
};

export type DatasetSampleEntry = {
  fileName: string;
  sample: DatasetSampleRecord;
};

const createDatasetSampleEntries = (
  sampleModules: Record<string, DatasetSampleRecord>,
): DatasetSampleEntry[] =>
  Object.entries(sampleModules)
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([path, sample]) => ({
      fileName: path.split("/").at(-1) ?? path,
      sample,
    }));

const sampleModules = import.meta.glob<DatasetSampleRecord>(
  "../../direct-out-samples/sample0000[0-9][0-9].json",
  {
    eager: true,
    import: "default",
  },
);

const simplifiedSampleModules = import.meta.glob<DatasetSampleRecord>(
  "../../simplified-samples/sample0000[0-9][0-9].json",
  {
    eager: true,
    import: "default",
  },
);

export const datasetSampleEntries = createDatasetSampleEntries(sampleModules);
export const simplifiedDatasetSampleEntries = createDatasetSampleEntries(
  simplifiedSampleModules,
);

export const firstHundredDatasetSampleEntries = datasetSampleEntries;
export const firstHundredSimplifiedDatasetSampleEntries =
  simplifiedDatasetSampleEntries;

export const clampSampleIndex = (value: number, sampleCount: number) => {
  if (sampleCount <= 0) return 0;

  return Math.max(0, Math.min(value, sampleCount - 1));
};

export const getSampleRoutes = (
  sample: DatasetSampleRecord,
): HighDensityIntraNodeRoute[] => sample.solution ?? sample.solvedRoutes ?? [];
