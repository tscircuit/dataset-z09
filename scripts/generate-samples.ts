import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import {
  DEFAULT_SAMPLE_COUNT,
  createSampleFileName,
  generateNodeWithPortPoints,
  scaleNodeWithPortPoints,
  stringifyWithFixedNumbers,
} from "../lib/generator";
import { DIRECT_OUT_SAMPLES_DIR_NAME } from "../lib/sample-directories";
import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../lib/types";

const DEFAULT_MAX_ITERATIONS = 250_000;
const DEFAULT_TRACE_WIDTH = 0.1;
const DEFAULT_VIA_DIAMETER = 0.3;
const SHRINK_FACTOR = 0.9;
const GROW_FACTOR = 1.1;

const parseSampleCount = (argv: string[]) => {
  const sampleCountFlagIndex = argv.findIndex(
    (argument) => argument === "--sample-count",
  );

  if (sampleCountFlagIndex === -1) return DEFAULT_SAMPLE_COUNT;

  const rawValue = argv[sampleCountFlagIndex + 1];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid --sample-count value: ${rawValue ?? "(missing)"}`);
  }

  return parsedValue;
};

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

type SolverEvaluation = {
  solution: HighDensityIntraNodeRoute[] | null;
  solvable: boolean;
};

const evaluateNode = (
  nodeWithPortPoints: NodeWithPortPoints,
): SolverEvaluation => {
  try {
    const solver = new HyperSingleIntraNodeSolver({
      nodeWithPortPoints,
      effort: 1,
      traceWidth: DEFAULT_TRACE_WIDTH,
      viaDiameter: DEFAULT_VIA_DIAMETER,
    });

    solver.MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;
    solver.solve();

    return {
      solvable: solver.solved,
      solution: solver.solved
        ? (solver.solvedRoutes as HighDensityIntraNodeRoute[])
        : null,
    };
  } catch (error) {
    console.error(
      `Failed to evaluate ${nodeWithPortPoints.capacityMeshNodeId}:`,
      error,
    );
    return {
      solvable: false,
      solution: null,
    };
  }
};

type SolvedNodeSearchResult = {
  attempts: number;
  nodeWithPortPoints: NodeWithPortPoints;
  solvable: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
};

type SampleWriteResult = {
  attempts: number;
  sample: DatasetSample;
};

const logAttempt = (
  sampleIndex: number,
  attempt: number,
  nodeWithPortPoints: NodeWithPortPoints,
  solvable: boolean,
  phase: "initial" | "grow" | "shrink",
) => {
  console.log(
    `[${createSampleFileName(sampleIndex)}] attempt=${attempt} phase=${phase} size=${nodeWithPortPoints.width.toFixed(2)}x${nodeWithPortPoints.height.toFixed(2)} routes=${nodeWithPortPoints.portPoints.length / 2} solvable=${solvable}`,
  );
};

const findSmallestSolvableNode = (
  sampleIndex: number,
  initialNode: NodeWithPortPoints,
): SolvedNodeSearchResult => {
  let attempts = 1;
  let currentNode = initialNode;
  let currentEvaluation = evaluateNode(currentNode);

  logAttempt(
    sampleIndex,
    attempts,
    currentNode,
    currentEvaluation.solvable,
    "initial",
  );

  if (currentEvaluation.solvable) {
    let smallestSolvableNode = currentNode;
    let smallestSolvableSolution = currentEvaluation.solution;

    while (true) {
      const smallerNode = scaleNodeWithPortPoints(currentNode, SHRINK_FACTOR);
      if (!smallerNode) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solution: smallestSolvableSolution,
        };
      }

      currentNode = smallerNode;
      attempts += 1;
      currentEvaluation = evaluateNode(currentNode);

      logAttempt(
        sampleIndex,
        attempts,
        currentNode,
        currentEvaluation.solvable,
        "shrink",
      );

      if (!currentEvaluation.solvable) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solution: smallestSolvableSolution,
        };
      }

      smallestSolvableNode = currentNode;
      smallestSolvableSolution = currentEvaluation.solution;
    }
  }

  while (true) {
    const largerNode = scaleNodeWithPortPoints(currentNode, GROW_FACTOR);
    if (!largerNode) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: false,
        solution: null,
      };
    }

    currentNode = largerNode;
    attempts += 1;
    currentEvaluation = evaluateNode(currentNode);

    logAttempt(
      sampleIndex,
      attempts,
      currentNode,
      currentEvaluation.solvable,
      "grow",
    );

    if (currentEvaluation.solvable) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: true,
        solution: currentEvaluation.solution,
      };
    }
  }
};

const writeSampleFile = async (samplePath: string, sample: DatasetSample) => {
  await Bun.write(samplePath, `${stringifyWithFixedNumbers(sample)}\n`);
};

const writeGeneratedSample = async (
  samplesDir: string,
  sampleIndex: number,
): Promise<SampleWriteResult> => {
  const initialNodeWithPortPoints = generateNodeWithPortPoints(sampleIndex);
  const solvedNodeSearch = findSmallestSolvableNode(
    sampleIndex,
    initialNodeWithPortPoints,
  );
  const sample: DatasetSample = {
    ...solvedNodeSearch.nodeWithPortPoints,
    solvable: solvedNodeSearch.solvable,
    solution: solvedNodeSearch.solution,
  };
  const samplePath = join(samplesDir, createSampleFileName(sampleIndex));

  await writeSampleFile(samplePath, sample);

  return {
    attempts: solvedNodeSearch.attempts,
    sample,
  };
};

const backfillExistingSampleSolution = async (
  samplePath: string,
  sample: DatasetSample,
): Promise<SampleWriteResult> => {
  const { solvable, solution } = evaluateNode(sample);
  const updatedSample: DatasetSample = {
    ...sample,
    solvable,
    solution,
  };

  await writeSampleFile(samplePath, updatedSample);

  return {
    attempts: 1,
    sample: updatedSample,
  };
};

const readExistingSample = async (samplePath: string) =>
  (await Bun.file(samplePath).json()) as DatasetSample;

const hasStoredSolution = (sample: DatasetSample) =>
  sample.solution !== undefined;

const removeExtraSamples = async (
  samplesDir: string,
  sampleCount: number,
  workerAssignment: WorkerAssignment | null,
) => {
  const expectedFileNames = new Set(
    Array.from({ length: sampleCount }, (_, index) => index)
      .filter((sampleIndex) =>
        isAssignedToWorker(sampleIndex, workerAssignment),
      )
      .map((sampleIndex) => createSampleFileName(sampleIndex)),
  );
  const existingFiles = await readdir(samplesDir);

  await Promise.all(
    existingFiles
      .filter(
        (fileName) =>
          /^sample\d{6}\.json$/.test(fileName) &&
          (() => {
            const sampleMatch = fileName.match(/^sample(\d{6})\.json$/);
            if (!sampleMatch) return false;

            const [, sampleIndexRaw] = sampleMatch;
            if (!sampleIndexRaw) return false;

            const sampleIndex = Number.parseInt(sampleIndexRaw, 10);
            return (
              isAssignedToWorker(sampleIndex, workerAssignment) &&
              !expectedFileNames.has(fileName)
            );
          })(),
      )
      .map((fileName) => rm(join(samplesDir, fileName))),
  );
};

const main = async () => {
  const argv = process.argv.slice(2);
  const sampleCount = parseSampleCount(argv);
  const resume = parseResumeFlag(argv);
  const workerAssignment = parseWorkerAssignment(argv);
  const samplesDir = join(process.cwd(), DIRECT_OUT_SAMPLES_DIR_NAME);

  await mkdir(samplesDir, { recursive: true });
  if (!resume) {
    await removeExtraSamples(samplesDir, sampleCount, workerAssignment);
  }

  const existingFiles = new Set(await readdir(samplesDir));

  let solvableCount = 0;
  let skippedCount = 0;
  let backfilledCount = 0;
  let processedCount = 0;

  if (workerAssignment) {
    console.log(
      `Worker ${workerAssignment.workerNumber}/${workerAssignment.workerCount} processing sample indices where (sampleIndex + 1) % ${workerAssignment.workerCount} === ${workerAssignment.workerNumber % workerAssignment.workerCount}`,
    );
  }

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    if (!isAssignedToWorker(sampleIndex, workerAssignment)) {
      continue;
    }

    processedCount += 1;
    const sampleFileName = createSampleFileName(sampleIndex);
    const samplePath = join(samplesDir, sampleFileName);

    if (resume && existingFiles.has(sampleFileName)) {
      const sample = await readExistingSample(samplePath);
      if (hasStoredSolution(sample)) {
        if (sample.solvable) solvableCount += 1;
        skippedCount += 1;

        console.log(
          `${sampleFileName} skipped existing sample solvable=${sample.solvable} routes=${sample.portPoints.length / 2} size=${sample.width.toFixed(2)}x${sample.height.toFixed(2)}`,
        );
        continue;
      }

      const backfilled = await backfillExistingSampleSolution(
        samplePath,
        sample,
      );
      if (backfilled.sample.solvable) solvableCount += 1;
      backfilledCount += 1;

      console.log(
        `${sampleFileName} backfilled solution solvable=${backfilled.sample.solvable} attempts=${backfilled.attempts} routes=${backfilled.sample.portPoints.length / 2} size=${backfilled.sample.width.toFixed(2)}x${backfilled.sample.height.toFixed(2)}`,
      );
      continue;
    }

    const { attempts, sample } = await writeGeneratedSample(
      samplesDir,
      sampleIndex,
    );
    if (sample.solvable) solvableCount += 1;

    console.log(
      `${sampleFileName} final solvable=${sample.solvable} attempts=${attempts} routes=${sample.portPoints.length / 2} size=${sample.width.toFixed(2)}x${sample.height.toFixed(2)}`,
    );
  }

  console.log(
    `Processed ${processedCount} samples (${solvableCount} solvable, ${
      processedCount - solvableCount
    } unsolved, ${skippedCount} skipped, ${backfilledCount} backfilled)`,
  );
};

main().catch((error) => {
  console.error("Failed to generate samples:", error);
  process.exit(1);
});
