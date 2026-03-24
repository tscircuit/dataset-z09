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

const evaluateSolvable = (nodeWithPortPoints: NodeWithPortPoints) => {
  try {
    const solver = new HyperSingleIntraNodeSolver({
      nodeWithPortPoints,
      effort: 1,
      traceWidth: DEFAULT_TRACE_WIDTH,
      viaDiameter: DEFAULT_VIA_DIAMETER,
    });

    solver.MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;
    solver.solve();

    return solver.solved;
  } catch (error) {
    console.error(
      `Failed to evaluate ${nodeWithPortPoints.capacityMeshNodeId}:`,
      error,
    );
    return false;
  }
};

type SolvedNodeSearchResult = {
  attempts: number;
  nodeWithPortPoints: NodeWithPortPoints;
  solvable: boolean;
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
  let currentSolvable = evaluateSolvable(currentNode);

  logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "initial");

  if (currentSolvable) {
    let smallestSolvableNode = currentNode;

    while (true) {
      const smallerNode = scaleNodeWithPortPoints(currentNode, SHRINK_FACTOR);
      if (!smallerNode) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
        };
      }

      currentNode = smallerNode;
      attempts += 1;
      currentSolvable = evaluateSolvable(currentNode);

      logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "shrink");

      if (!currentSolvable) {
        return {
          attempts,
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
        };
      }

      smallestSolvableNode = currentNode;
    }
  }

  while (true) {
    const largerNode = scaleNodeWithPortPoints(currentNode, GROW_FACTOR);
    if (!largerNode) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: false,
      };
    }

    currentNode = largerNode;
    attempts += 1;
    currentSolvable = evaluateSolvable(currentNode);

    logAttempt(sampleIndex, attempts, currentNode, currentSolvable, "grow");

    if (currentSolvable) {
      return {
        attempts,
        nodeWithPortPoints: currentNode,
        solvable: true,
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
  };
  const samplePath = join(samplesDir, createSampleFileName(sampleIndex));

  await Bun.write(samplePath, `${stringifyWithFixedNumbers(sample)}\n`);

  return {
    attempts: solvedNodeSearch.attempts,
    sample,
  };
};

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
  const sampleCount = parseSampleCount(process.argv.slice(2));
  const samplesDir = join(process.cwd(), "samples");

  await mkdir(samplesDir, { recursive: true });
  await removeExtraSamples(samplesDir, sampleCount);

  let solvableCount = 0;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const { attempts, sample } = await writeSample(samplesDir, sampleIndex);
    if (sample.solvable) solvableCount += 1;

    console.log(
      `${createSampleFileName(sampleIndex)} final solvable=${sample.solvable} attempts=${attempts} routes=${sample.portPoints.length / 2} size=${sample.width.toFixed(2)}x${sample.height.toFixed(2)}`,
    );
  }

  console.log(
    `Generated ${sampleCount} samples (${solvableCount} solvable, ${
      sampleCount - solvableCount
    } unsolved)`,
  );
};

main().catch((error) => {
  console.error("Failed to generate samples:", error);
  process.exit(1);
});
