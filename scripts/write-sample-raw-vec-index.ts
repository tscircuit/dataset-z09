import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SAMPLE_FILE_PATTERN,
  SIMPLIFIED_SAMPLES_DIR_NAME,
} from "../lib/sample-directories";
import type { DatasetSample } from "../lib/types";
import { VEC_RAW_VERSION, computeVecRaw } from "../lib/vec-raw";
import type { SampleRawVecIndexEntry } from "../lib/vector-search";

const SAMPLE_RAW_VEC_INDEX_FILE_NAME = "sample-raw-vec-index.json";
const LOG_EVERY = 500;

const main = async () => {
  const samplesDir = join(process.cwd(), SIMPLIFIED_SAMPLES_DIR_NAME);
  const outputPath = join(process.cwd(), SAMPLE_RAW_VEC_INDEX_FILE_NAME);
  const fileNames = (await readdir(samplesDir))
    .filter((fileName) => SAMPLE_FILE_PATTERN.test(fileName))
    .sort();
  const entries: SampleRawVecIndexEntry[] = [];

  for (const [index, fileName] of fileNames.entries()) {
    const samplePath = join(samplesDir, fileName);
    const sample = (await Bun.file(samplePath).json()) as DatasetSample;
    entries.push({
      fileName,
      vecRaw: computeVecRaw(sample),
    });

    if ((index + 1) % LOG_EVERY === 0) {
      console.log(`Indexed ${index + 1} samples (latest=${fileName})`);
    }
  }

  await writeFile(
    outputPath,
    `${JSON.stringify({ version: VEC_RAW_VERSION, entries })}\n`,
  );
  console.log(
    `Wrote ${entries.length} entries to ${SAMPLE_RAW_VEC_INDEX_FILE_NAME}`,
  );
};

main().catch((error) => {
  console.error("Failed to write sample raw vec index:", error);
  process.exit(1);
});
