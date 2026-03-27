import { join } from "node:path";
import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import { scaleNodeWithPortPoints } from "../lib/generator";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import {
  canonicalizeDatasetSample,
  createEmptySolveCache,
  createSolveCacheEntry,
  getNodePointPairCount,
  getSolveCacheCandidates,
  parseSolveCacheFile,
  serializeSolveCacheFile,
  tryApplySolveCacheEntry,
} from "../lib/solve-cache";
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../lib/types";

const DEFAULT_MAX_ITERATIONS = 250_000;
const DEFAULT_TRACE_WIDTH = 0.1;
const DEFAULT_VIA_DIAMETER = 0.3;
const DEFAULT_POINT_PAIR_COUNT = 2;
const SHRINK_FACTOR = 0.9;
const GROW_FACTOR = 1.1;
const MAX_CACHE_CANDIDATES_TO_TRY = 16;
const ROLLING_WINDOW_SIZE = 100;

type SolverEvaluation = {
  solvable: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
};

type SolvedNodeSearchResult = {
  nodeWithPortPoints: NodeWithPortPoints;
  solvable: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
};

const parseIntegerFlag = (
  argv: string[],
  flagName: string,
  defaultValue: number,
) => {
  const flagIndex = argv.findIndex((argument) => argument === flagName);
  if (flagIndex === -1) {
    return defaultValue;
  }

  const rawValue = argv[flagIndex + 1];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${flagName} value: ${rawValue ?? "(missing)"}`);
  }

  return parsedValue;
};

const parseOptionalIntegerFlag = (argv: string[], flagName: string) => {
  const flagIndex = argv.findIndex((argument) => argument === flagName);
  if (flagIndex === -1) {
    return null;
  }

  const rawValue = argv[flagIndex + 1];
  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${flagName} value: ${rawValue ?? "(missing)"}`);
  }

  return parsedValue;
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

const findSmallestSolvableNode = (
  initialNodeWithPortPoints: NodeWithPortPoints,
): SolvedNodeSearchResult => {
  let currentNodeWithPortPoints = initialNodeWithPortPoints;
  let currentEvaluation = evaluateNode(currentNodeWithPortPoints);

  if (currentEvaluation.solvable) {
    let smallestSolvableNode = currentNodeWithPortPoints;
    let smallestSolvableSolution = currentEvaluation.solution;

    while (true) {
      const smallerNodeWithPortPoints = scaleNodeWithPortPoints(
        currentNodeWithPortPoints,
        SHRINK_FACTOR,
      );

      if (!smallerNodeWithPortPoints) {
        return {
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solution: smallestSolvableSolution,
        };
      }

      currentNodeWithPortPoints = smallerNodeWithPortPoints;
      currentEvaluation = evaluateNode(currentNodeWithPortPoints);

      if (!currentEvaluation.solvable) {
        return {
          nodeWithPortPoints: smallestSolvableNode,
          solvable: true,
          solution: smallestSolvableSolution,
        };
      }

      smallestSolvableNode = currentNodeWithPortPoints;
      smallestSolvableSolution = currentEvaluation.solution;
    }
  }

  while (true) {
    const largerNodeWithPortPoints = scaleNodeWithPortPoints(
      currentNodeWithPortPoints,
      GROW_FACTOR,
    );

    if (!largerNodeWithPortPoints) {
      return {
        nodeWithPortPoints: currentNodeWithPortPoints,
        solvable: false,
        solution: null,
      };
    }

    currentNodeWithPortPoints = largerNodeWithPortPoints;
    currentEvaluation = evaluateNode(currentNodeWithPortPoints);

    if (currentEvaluation.solvable) {
      return {
        nodeWithPortPoints: currentNodeWithPortPoints,
        solvable: true,
        solution: currentEvaluation.solution,
      };
    }
  }
};

const createRandomSample = (pointPairCount: number) => {
  const sampleIndex = 1_000_000 + Math.floor(Math.random() * 9_000_000);
  return canonicalizeDatasetSample(
    createMatchSampleWithPairCount(sampleIndex, pointPairCount),
  );
};

const computeRollingAccuracy = (rollingResults: boolean[]) => {
  if (rollingResults.length === 0) return 0;
  const hitCount = rollingResults.filter(Boolean).length;
  return hitCount / rollingResults.length;
};

const hasPerfectRollingAccuracy = (rollingResults: boolean[]) =>
  rollingResults.length === ROLLING_WINDOW_SIZE &&
  rollingResults.every((result) => result);

const loadSolveCache = async (cachePath: string, pointPairCount: number) => {
  const cacheFile = Bun.file(cachePath);
  if (!(await cacheFile.exists())) {
    return createEmptySolveCache(pointPairCount);
  }

  const rawCache = await cacheFile.text();
  if (rawCache.trim().length === 0) {
    return createEmptySolveCache(pointPairCount);
  }

  return parseSolveCacheFile(JSON.parse(rawCache), pointPairCount);
};

const saveSolveCache = async (
  cachePath: string,
  pointPairCount: number,
  entries: ReturnType<typeof createEmptySolveCache>["entries"],
) => {
  await Bun.write(
    cachePath,
    serializeSolveCacheFile({
      pointPairCount,
      entries,
    }),
  );
};

const main = async () => {
  const argv = process.argv.slice(2);
  const pointPairCount = parseIntegerFlag(
    argv,
    "--point-pairs",
    DEFAULT_POINT_PAIR_COUNT,
  );
  const maxSamples = parseOptionalIntegerFlag(argv, "--sample-count");
  const cachePath = join(process.cwd(), `solve-cache-${pointPairCount}.json`);
  const solveCache = await loadSolveCache(cachePath, pointPairCount);
  const rollingResults: boolean[] = [];
  let generatedSampleCount = 0;

  while (!hasPerfectRollingAccuracy(rollingResults)) {
    if (maxSamples !== null && generatedSampleCount >= maxSamples) {
      throw new Error(
        `Stopped after ${maxSamples} generated samples before rolling100Accuracy reached 1.000`,
      );
    }

    const sample = createRandomSample(pointPairCount);
    generatedSampleCount += 1;

    if (getNodePointPairCount(sample) !== pointPairCount) {
      throw new Error(
        `Generated sample has ${getNodePointPairCount(sample)} point pairs, expected ${pointPairCount}`,
      );
    }

    const candidates = getSolveCacheCandidates(
      sample,
      solveCache.entries,
    ).slice(0, MAX_CACHE_CANDIDATES_TO_TRY);

    let hit = false;

    for (const candidate of candidates) {
      const appliedSolveCacheEntry = tryApplySolveCacheEntry(
        sample,
        candidate.entry,
      );

      if (!appliedSolveCacheEntry) {
        continue;
      }

      hit = true;
      break;
    }

    if (!hit) {
      const solvedNode = findSmallestSolvableNode(sample);

      if (solvedNode.solvable && solvedNode.solution) {
        solveCache.entries.push(
          createSolveCacheEntry(
            solvedNode.nodeWithPortPoints,
            solvedNode.solution,
          ),
        );
        await saveSolveCache(cachePath, pointPairCount, solveCache.entries);
      }
    }

    rollingResults.push(hit);
    if (rollingResults.length > ROLLING_WINDOW_SIZE) {
      rollingResults.shift();
    }

    const rolling100Accuracy = computeRollingAccuracy(rollingResults);

    console.log(
      `cacheSize=${solveCache.entries.length
        .toString()
        .padStart(8, " ")} rolling100Accuracy=${rolling100Accuracy.toFixed(3)}`,
    );
  }

  console.log(
    `Completed after ${generatedSampleCount} generated samples with rolling100Accuracy=1.000`,
  );
};

main().catch((error) => {
  console.error("Failed to generate solve cache:", error);
  process.exit(1);
});
