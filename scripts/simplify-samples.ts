import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runForceDirectedImprovement } from "../lib/force-improve";
import { stringifyWithFixedNumbers } from "../lib/generator";
import {
  DIRECT_OUT_SAMPLES_DIR_NAME,
  SAMPLE_FILE_PATTERN,
  SIMPLIFIED_SAMPLES_DIR_NAME,
} from "../lib/sample-directories";
import { simplifyRoutes } from "../lib/simplify";
import type { DatasetSample } from "../lib/types";

const FORCE_IMPROVEMENT_PASSES = 500;
const LOG_EVERY = 100;

const parseResumeFlag = (argv: string[]) => argv.includes("--resume");

type WorkerAssignment = {
  workerNumber: number;
  workerCount: number;
};

const parseWorkerAssignment = (argv: string[]): WorkerAssignment | null => {
  const workerFlagIndex = argv.findIndex((argument) => argument === "--worker");

  if (workerFlagIndex === -1) return null;

  const rawValue = argv[workerFlagIndex + 1];
  const match = rawValue?.match(/^(\d+)\/(\d+)$/);

  if (!match) {
    throw new Error(`Invalid --worker value: ${rawValue ?? "(missing)"}`);
  }

  const [, workerNumberRaw, workerCountRaw] = match;
  if (!workerNumberRaw || !workerCountRaw) {
    throw new Error(`Invalid --worker value: ${rawValue ?? "(missing)"}`);
  }

  const workerNumber = Number.parseInt(workerNumberRaw, 10);
  const workerCount = Number.parseInt(workerCountRaw, 10);

  if (
    !Number.isFinite(workerNumber) ||
    !Number.isFinite(workerCount) ||
    workerNumber <= 0 ||
    workerCount <= 0 ||
    workerNumber > workerCount
  ) {
    throw new Error(`Invalid --worker value: ${rawValue}`);
  }

  return {
    workerNumber,
    workerCount,
  };
};

const isAssignedToWorker = (
  sampleIndex: number,
  workerAssignment: WorkerAssignment | null,
) => {
  if (!workerAssignment) return true;

  return (
    (sampleIndex + 1) % workerAssignment.workerCount ===
    workerAssignment.workerNumber % workerAssignment.workerCount
  );
};

const simplifySample = (sample: DatasetSample): DatasetSample => {
  if (!sample.solution || sample.solution.length === 0) {
    return sample;
  }

  const simplifiedRoutes = simplifyRoutes(sample.solution);
  const { routes } = runForceDirectedImprovement(
    sample,
    simplifiedRoutes,
    FORCE_IMPROVEMENT_PASSES,
  );

  return {
    ...sample,
    solution: routes,
  };
};

const writeSampleFile = async (samplePath: string, sample: DatasetSample) => {
  await Bun.write(samplePath, `${stringifyWithFixedNumbers(sample)}\n`);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const resume = parseResumeFlag(argv);
  const workerAssignment = parseWorkerAssignment(argv);
  const directOutSamplesDir = join(process.cwd(), DIRECT_OUT_SAMPLES_DIR_NAME);
  const simplifiedSamplesDir = join(process.cwd(), SIMPLIFIED_SAMPLES_DIR_NAME);

  await mkdir(simplifiedSamplesDir, { recursive: true });

  const fileNames = (await readdir(directOutSamplesDir))
    .filter((fileName) => SAMPLE_FILE_PATTERN.test(fileName))
    .sort();
  const existingSimplifiedFileNames = resume
    ? new Set(await readdir(simplifiedSamplesDir))
    : new Set<string>();

  let processedCount = 0;
  let simplifiedCount = 0;
  let unsolvedCount = 0;
  let skippedCount = 0;

  if (workerAssignment) {
    console.log(
      `Worker ${workerAssignment.workerNumber}/${workerAssignment.workerCount} simplifying sample indices where (sampleIndex + 1) % ${workerAssignment.workerCount} === ${workerAssignment.workerNumber % workerAssignment.workerCount}`,
    );
  }

  for (const [index, fileName] of fileNames.entries()) {
    const sampleMatch = fileName.match(/^sample(\d{6})\.json$/);
    const sampleIndexRaw = sampleMatch?.[1];
    const sampleIndex = sampleIndexRaw
      ? Number.parseInt(sampleIndexRaw, 10)
      : index;
    if (!isAssignedToWorker(sampleIndex, workerAssignment)) {
      continue;
    }

    if (resume && existingSimplifiedFileNames.has(fileName)) {
      skippedCount += 1;
      continue;
    }

    const directOutSamplePath = join(directOutSamplesDir, fileName);
    const simplifiedSamplePath = join(simplifiedSamplesDir, fileName);
    const sample = (await Bun.file(
      directOutSamplePath,
    ).json()) as DatasetSample;
    const simplifiedSample = simplifySample(sample);

    await writeSampleFile(simplifiedSamplePath, simplifiedSample);
    processedCount += 1;

    if (simplifiedSample.solution && simplifiedSample.solution.length > 0) {
      simplifiedCount += 1;
    } else {
      unsolvedCount += 1;
    }

    if (processedCount % LOG_EVERY === 0) {
      console.log(
        `Processed ${processedCount} samples (latest=${fileName}, simplified=${simplifiedCount}, unsolved=${unsolvedCount}, skipped=${skippedCount})`,
      );
    }
  }

  console.log(
    `Processed ${processedCount} direct-out samples into ${SIMPLIFIED_SAMPLES_DIR_NAME} (${simplifiedCount} with simplified routes, ${unsolvedCount} without stored solutions, ${skippedCount} skipped)`,
  );
};

main().catch((error) => {
  console.error("Failed to simplify samples:", error);
  process.exit(1);
});
