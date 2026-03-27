import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
} from "../../lib/types";

export type DatasetSampleRecord = DatasetSample & {
  solvedRoutes?: HighDensityIntraNodeRoute[] | null;
};

export type DatasetSampleEntry = {
  fileName: string;
  sample: DatasetSampleRecord;
};

const sampleModules = import.meta.glob<DatasetSampleRecord>(
  "../../samples/sample0000[0-9][0-9].json",
  {
    eager: true,
    import: "default",
  },
);

export const datasetSampleEntries: DatasetSampleEntry[] = Object.entries(
  sampleModules,
)
  .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
  .map(([path, sample]) => ({
    fileName: path.split("/").at(-1) ?? path,
    sample,
  }));

export const firstHundredDatasetSampleEntries = datasetSampleEntries;

export const clampSampleIndex = (value: number, sampleCount: number) => {
  if (sampleCount <= 0) return 0;

  return Math.max(0, Math.min(value, sampleCount - 1));
};

export const getSampleRoutes = (
  sample: DatasetSampleRecord,
): HighDensityIntraNodeRoute[] => sample.solution ?? sample.solvedRoutes ?? [];
