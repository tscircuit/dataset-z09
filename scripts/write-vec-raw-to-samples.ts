import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stringifyWithFixedNumbers } from "../lib/generator";
import {
  SAMPLE_FILE_PATTERN,
  SIMPLIFIED_SAMPLES_DIR_NAME,
} from "../lib/sample-directories";
import type { DatasetSample } from "../lib/types";
import { computeVecRaw } from "../lib/vec-raw";

const LOG_EVERY = 500;

const writeSampleFile = async (samplePath: string, sample: DatasetSample) => {
  await Bun.write(samplePath, `${stringifyWithFixedNumbers(sample)}\n`);
};

const main = async () => {
  const samplesDir = join(process.cwd(), SIMPLIFIED_SAMPLES_DIR_NAME);
  const fileNames = (await readdir(samplesDir))
    .filter((fileName) => SAMPLE_FILE_PATTERN.test(fileName))
    .sort();

  let processedCount = 0;

  for (const fileName of fileNames) {
    const samplePath = join(samplesDir, fileName);
    const sample = (await Bun.file(samplePath).json()) as DatasetSample;
    const updatedSample: DatasetSample = {
      ...sample,
      vecRaw: computeVecRaw(sample),
    };

    await writeSampleFile(samplePath, updatedSample);
    processedCount += 1;

    if (processedCount % LOG_EVERY === 0) {
      console.log(`Processed ${processedCount} samples (latest=${fileName})`);
    }
  }

  console.log(
    `Wrote vecRaw to ${processedCount} samples in ${SIMPLIFIED_SAMPLES_DIR_NAME}`,
  );
};

main().catch((error) => {
  console.error("Failed to write vecRaw to samples:", error);
  process.exit(1);
});
