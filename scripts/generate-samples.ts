import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import type { HighDensityIntraNodeRoute } from "@tscircuit/high-density-a01";
import {
  DEFAULT_SAMPLE_COUNT,
  createSampleFileName,
  generateNodeWithPortPoints,
  scaleNodeWithPortPoints,
  stringifyWithFixedNumbers,
} from "../lib/generator";
import type { DatasetSample, NodeWithPortPoints } from "../lib/types";

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

type SolveEvaluation = {
  solvable: boolean;
  solvedRoutes: HighDensityIntraNodeRoute[];
};

const evaluateSolvable = (
  nodeWithPortPoints: NodeWithPortPoints,
): SolveEvaluation => {
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
      solvedRoutes: solver.solvedRoutes ?? [],
    };
  } catch (error) {
    console.error(
      `Failed to evaluate ${nodeWithPortPoints.capacityMeshNodeId}:`,
      error,
    );
    return {
      solvable: false,
      solvedRoutes: [],
    };
  }
};

type SolvedNodeSearchResult = {
  attempts: number;
  nodeWithPortPoints: NodeWithPortPoints;
  solvable: boolean;
  solvedRoutes: HighDensityIntraNodeRoute[];
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
  let currentEvaluation = evaluateSolvable(currentNode);
  let currentSolvable = currentEvaluation.solvable;

  logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "initial");

  if (currentSolvable) {
    let smallestSolvableNode = currentNode;
    let smallestSolvedRoutes = currentEvaluation.solvedRoutes;

    while (true) {
      const smallerNode = scaleNodeWithPortPoints(currentNode, SHRINK_FACTOR);
      if (!smallerNode) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solvedRoutes: smallestSolvedRoutes,
        };
      }

      currentNode = smallerNode;
      attempts += 1;
      currentEvaluation = evaluateSolvable(currentNode);
      currentSolvable = currentEvaluation.solvable;

      logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "shrink");

      if (!currentSolvable) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solvedRoutes: smallestSolvedRoutes,
        };
      }

      smallestSolvableNode = currentNode;
      smallestSolvedRoutes = currentEvaluation.solvedRoutes;
    }
  }

  while (true) {
    const largerNode = scaleNodeWithPortPoints(currentNode, GROW_FACTOR);
    if (!largerNode) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: false,
        solvedRoutes: [],
      };
    }

    currentNode = largerNode;
    attempts += 1;
    currentEvaluation = evaluateSolvable(currentNode);
    currentSolvable = currentEvaluation.solvable;

    logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "grow");

    if (currentSolvable) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: true,
        solvedRoutes: currentEvaluation.solvedRoutes,
      };
    }
  }
};

const writeSample = async (samplesDir: string, sampleIndex: number) => {
  const initialNodeWithPortPoints = generateNodeWithPortPoints(sampleIndex);
  const solvedNodeSearch = findSmallestSolvableNode(
    sampleIndex,
    initialNodeWithPortPoints,
  );
  const sample: DatasetSample = {
    ...solvedNodeSearch.nodeWithPortPoints,
    solvable: solvedNodeSearch.solvable,
    solvedRoutes: solvedNodeSearch.solvedRoutes,
  };
  const samplePath = join(samplesDir, createSampleFileName(sampleIndex));

  await Bun.write(samplePath, `${stringifyWithFixedNumbers(sample)}\n`);

  return {
    attempts: solvedNodeSearch.attempts,
    sample,
  };
};

const readExistingSample = async (samplePath: string) =>
  (await Bun.file(samplePath).json()) as DatasetSample;

const removeExtraSamples = async (samplesDir: string, sampleCount: number) => {
  const expectedFileNames = new Set(
    Array.from({ length: sampleCount }, (_, index) =>
      createSampleFileName(index),
    ),
  );
  const existingFiles = await readdir(samplesDir);

  await Promise.all(
    existingFiles
      .filter(
        (fileName) =>
          /^sample\d{6}\.json$/.test(fileName) &&
          !expectedFileNames.has(fileName),
      )
      .map((fileName) => rm(join(samplesDir, fileName))),
  );
};

const main = async () => {
  const argv = process.argv.slice(2);
  const sampleCount = parseSampleCount(argv);
  const resume = parseResumeFlag(argv);
  const samplesDir = join(process.cwd(), "samples");

  await mkdir(samplesDir, { recursive: true });
  if (!resume) {
    await removeExtraSamples(samplesDir, sampleCount);
  }

  const existingFiles = new Set(await readdir(samplesDir));

  let solvableCount = 0;
  let skippedCount = 0;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const sampleFileName = createSampleFileName(sampleIndex);
    const samplePath = join(samplesDir, sampleFileName);

    if (resume && existingFiles.has(sampleFileName)) {
      const sample = await readExistingSample(samplePath);
      if (sample.solvable) solvableCount += 1;
      skippedCount += 1;

      console.log(
        `${sampleFileName} skipped existing sample solvable=${sample.solvable} routes=${sample.portPoints.length / 2} size=${sample.width.toFixed(2)}x${sample.height.toFixed(2)}`,
      );
      continue;
    }

    const { attempts, sample } = await writeSample(samplesDir, sampleIndex);
    if (sample.solvable) solvableCount += 1;

    console.log(
      `${sampleFileName} final solvable=${sample.solvable} attempts=${attempts} routes=${sample.portPoints.length / 2} size=${sample.width.toFixed(2)}x${sample.height.toFixed(2)}`,
    );
  }

  console.log(
    `Processed ${sampleCount} samples (${solvableCount} solvable, ${
      sampleCount - solvableCount
    } unsolved, ${skippedCount} skipped)`,
  );
};

main().catch((error) => {
  console.error("Failed to generate samples:", error);
  process.exit(1);
});
