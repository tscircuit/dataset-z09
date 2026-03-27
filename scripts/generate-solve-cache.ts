import { join } from "node:path";
import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import { scaleNodeWithPortPoints } from "../lib/generator";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import {
  type SolveCacheEntry,
  canonicalizeDatasetSample,
  createEmptySolveCache,
  createValidatedSolveCacheEntry,
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
const FINE_SHRINK_FACTOR = 0.98;
const GROW_FACTOR = 1.1;
const MAX_CACHE_CANDIDATES_TO_TRY = 16;
const ROLLING_WINDOW_SIZE = 100;

type SolverEvaluation = {
  solverSolved: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
  validatedSolveCacheEntry: SolveCacheEntry | null;
};

type SolvedNodeSearchResult = {
  nodeWithPortPoints: NodeWithPortPoints;
  solvable: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
  validatedSolveCacheEntry: SolveCacheEntry | null;
};

const getFlagValue = (
  argv: string[],
  flagNames: string[],
): string | undefined => {
  let matchedValue: string | undefined;

  for (const flagName of flagNames) {
    const flagIndex = argv.findIndex((argument) => argument === flagName);
    if (flagIndex === -1) {
      continue;
    }

    const rawValue = argv[flagIndex + 1];
    if (matchedValue === undefined) {
      matchedValue = rawValue;
      continue;
    }

    if (rawValue !== matchedValue) {
      throw new Error(
        `Conflicting values provided for ${flagNames.join(", ")}: ${matchedValue} vs ${rawValue ?? "(missing)"}`,
      );
    }
  }

  return matchedValue;
};

const parseIntegerFlag = (
  argv: string[],
  flagNames: string[],
  defaultValue: number,
) => {
  const rawValue = getFlagValue(argv, flagNames);

  if (rawValue === undefined) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `Invalid ${flagNames.join("/")} value: ${rawValue ?? "(missing)"}`,
    );
  }

  return parsedValue;
};

const parseOptionalIntegerFlag = (argv: string[], flagNames: string[]) => {
  const rawValue = getFlagValue(argv, flagNames);

  if (rawValue === undefined) {
    return null;
  }

  const parsedValue = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `Invalid ${flagNames.join("/")} value: ${rawValue ?? "(missing)"}`,
    );
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

    const solution = solver.solved
      ? (solver.solvedRoutes as HighDensityIntraNodeRoute[])
      : null;
    const validatedSolveCacheEntry =
      solution === null
        ? null
        : createValidatedSolveCacheEntry(nodeWithPortPoints, solution);

    return {
      solverSolved: solver.solved,
      solution,
      validatedSolveCacheEntry,
    };
  } catch (error) {
    console.error(
      `Failed to evaluate ${nodeWithPortPoints.capacityMeshNodeId}:`,
      error,
    );
    return {
      solverSolved: false,
      solution: null,
      validatedSolveCacheEntry: null,
    };
  }
};

const toSolvedNodeSearchResult = (
  validatedSolveCacheEntry: SolveCacheEntry,
): SolvedNodeSearchResult => ({
  nodeWithPortPoints: validatedSolveCacheEntry.sample,
  solvable: true,
  solution: validatedSolveCacheEntry.solution,
  validatedSolveCacheEntry,
});

const shrinkSolveCacheEntryUntilFailure = (
  startingEntry: SolveCacheEntry,
  shrinkFactor: number,
) => {
  let smallestSolvableEntry = startingEntry;

  while (true) {
    const smallerNodeWithPortPoints = scaleNodeWithPortPoints(
      smallestSolvableEntry.sample,
      shrinkFactor,
    );

    if (!smallerNodeWithPortPoints) {
      return smallestSolvableEntry;
    }

    const smallerEvaluation = evaluateNode(smallerNodeWithPortPoints);
    const validatedSolveCacheEntry = smallerEvaluation.validatedSolveCacheEntry;

    if (!validatedSolveCacheEntry) {
      return smallestSolvableEntry;
    }

    smallestSolvableEntry = validatedSolveCacheEntry;
  }
};

const findSmallestValidatedSolveCacheEntry = (
  startingEntry: SolveCacheEntry,
) => {
  const coarseShrinkEntry = shrinkSolveCacheEntryUntilFailure(
    startingEntry,
    SHRINK_FACTOR,
  );

  return shrinkSolveCacheEntryUntilFailure(
    coarseShrinkEntry,
    FINE_SHRINK_FACTOR,
  );
};

const findSmallestSolvableNode = (
  initialNodeWithPortPoints: NodeWithPortPoints,
): SolvedNodeSearchResult => {
  let currentNodeWithPortPoints = initialNodeWithPortPoints;
  let currentEvaluation = evaluateNode(currentNodeWithPortPoints);
  const initialValidatedSolveCacheEntry =
    currentEvaluation.validatedSolveCacheEntry;

  if (initialValidatedSolveCacheEntry) {
    return toSolvedNodeSearchResult(
      findSmallestValidatedSolveCacheEntry(initialValidatedSolveCacheEntry),
    );
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
        validatedSolveCacheEntry: null,
      };
    }

    currentNodeWithPortPoints = largerNodeWithPortPoints;
    currentEvaluation = evaluateNode(currentNodeWithPortPoints);
    const validatedSolveCacheEntry = currentEvaluation.validatedSolveCacheEntry;

    if (validatedSolveCacheEntry) {
      return toSolvedNodeSearchResult(
        findSmallestValidatedSolveCacheEntry(validatedSolveCacheEntry),
      );
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
    ["--point-pairs", "--pair-count", "--pair-counts"],
    DEFAULT_POINT_PAIR_COUNT,
  );
  const maxSamples = parseOptionalIntegerFlag(argv, ["--sample-count"]);
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

      if (solvedNode.validatedSolveCacheEntry) {
        solveCache.entries.push(solvedNode.validatedSolveCacheEntry);
        await saveSolveCache(cachePath, pointPairCount, solveCache.entries);
      } else if (solvedNode.solution) {
        console.warn(
          `Discarded ${solvedNode.nodeWithPortPoints.capacityMeshNodeId} because the reusable route failed DRC after reattachment/force-improve`,
        );
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
