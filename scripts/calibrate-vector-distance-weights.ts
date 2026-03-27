import { join } from "node:path";
import { createDeterministicRandom, getSampleSeed } from "../lib/generator";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import {
  canonicalizeDatasetSample,
  diagnoseSolveCacheEntryApplication,
  getSolveCacheCandidates,
  parseSolveCacheFile,
} from "../lib/solve-cache";
import { canonicalizeRawVecStructure } from "../lib/vector-search";

const DEFAULT_SAMPLE_COUNT = 5;
const DEFAULT_PAIR_COUNT = 2;
const MAX_SAMPLE_ATTEMPTS_MULTIPLIER = 10;
const SAMPLE_INDEX_MIN = 1_000_000;
const SAMPLE_INDEX_RANGE = 9_000_000;
const TAU = Math.PI * 2;
const LEAST_SQUARES_MAX_ITERATIONS = 5_000;
const LEAST_SQUARES_TOLERANCE = 1e-9;
const LEAST_SQUARES_REGULARIZATION = 1e-6;
const AXES = [0, 1, 2] as const;

type WeightTriple = {
  ratio: number;
  angle: number;
  z: number;
};

type DistanceComponents = {
  ratio: number;
  angle: number;
  z: number;
};

type OptimizationResult = {
  weights: WeightTriple;
  bestValidDistance: number;
  bestInvalidDistance: number;
  margin: number;
};

type SampleCalibrationResult = OptimizationResult & {
  sampleIndex: number;
  sampleId: string;
  validCandidateCount: number;
  invalidCandidateCount: number;
};

const parseIntegerFlag = (
  argv: string[],
  flagNames: string[],
  defaultValue: number,
) => {
  for (const flagName of flagNames) {
    const flagIndex = argv.findIndex((argument) => argument === flagName);
    if (flagIndex === -1) {
      continue;
    }

    const rawValue = argv[flagIndex + 1];
    const parsedValue = Number.parseInt(rawValue ?? "", 10);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      throw new Error(
        `Invalid ${flagNames.join("/")} value: ${rawValue ?? "(missing)"}`,
      );
    }

    return parsedValue;
  }

  return defaultValue;
};

const parseStringFlag = (argv: string[], flagNames: string[]) => {
  for (const flagName of flagNames) {
    const flagIndex = argv.findIndex((argument) => argument === flagName);
    if (flagIndex === -1) {
      continue;
    }

    const rawValue = argv[flagIndex + 1];
    if (!rawValue) {
      throw new Error(`Missing ${flagName} value`);
    }

    return rawValue;
  }

  return null;
};

const normalizeAngleDelta = (delta: number) => {
  const normalizedDelta = (delta + Math.PI) % TAU;
  return normalizedDelta < 0
    ? normalizedDelta + TAU - Math.PI
    : normalizedDelta - Math.PI;
};

const getDistanceComponents = (
  leftVector: number[],
  rightVector: number[],
): DistanceComponents => {
  if (leftVector.length !== rightVector.length) {
    throw new Error(
      `Cannot compare vecRaw values of different lengths: ${leftVector.length} vs ${rightVector.length}`,
    );
  }

  const left = canonicalizeRawVecStructure(leftVector);
  const right = canonicalizeRawVecStructure(rightVector);
  const ratioDelta = (left[0] ?? 0) - (right[0] ?? 0);

  let angle = 0;
  let z = 0;

  for (let index = 1; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    if (index % 2 === 1) {
      const angleDelta = normalizeAngleDelta(leftValue - rightValue);
      angle += angleDelta * angleDelta;
    } else {
      const zDelta = leftValue - rightValue;
      z += zDelta * zDelta;
    }
  }

  return {
    ratio: ratioDelta * ratioDelta,
    angle,
    z,
  };
};

const getWeightedDistance = (
  components: DistanceComponents,
  weights: WeightTriple,
) =>
  components.ratio * weights.ratio +
  components.angle * weights.angle +
  components.z * weights.z;

const getAverageWeights = (
  results: SampleCalibrationResult[],
): WeightTriple => {
  const totals = results.reduce(
    (accumulator, result) => ({
      ratio: accumulator.ratio + result.weights.ratio,
      angle: accumulator.angle + result.weights.angle,
      z: accumulator.z + result.weights.z,
    }),
    { ratio: 0, angle: 0, z: 0 },
  );

  return {
    ratio: totals.ratio / results.length,
    angle: totals.angle / results.length,
    z: totals.z / results.length,
  };
};

const dot3 = (left: readonly number[], right: readonly number[]) =>
  (left[0] ?? 0) * (right[0] ?? 0) +
  (left[1] ?? 0) * (right[1] ?? 0) +
  (left[2] ?? 0) * (right[2] ?? 0);

const getComponentVector = (
  components: DistanceComponents,
): [number, number, number] => [
  components.ratio,
  components.angle,
  components.z,
];

const multiplyMatrixVector = (
  matrix: readonly [readonly number[], readonly number[], readonly number[]],
  vector: readonly number[],
): [number, number, number] => [
  dot3(matrix[0], vector),
  dot3(matrix[1], vector),
  dot3(matrix[2], vector),
];

const getLargestEigenvalue = (
  matrix: readonly [readonly number[], readonly number[], readonly number[]],
) => {
  let vector: [number, number, number] = [1, 1, 1];

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const multiplied = multiplyMatrixVector(matrix, vector);
    const magnitude = Math.hypot(...multiplied);
    if (magnitude <= 1e-12) {
      return 0;
    }

    vector = [
      multiplied[0] / magnitude,
      multiplied[1] / magnitude,
      multiplied[2] / magnitude,
    ];
  }

  return dot3(vector, multiplyMatrixVector(matrix, vector));
};

const projectToSimplex = (
  vector: [number, number, number],
): [number, number, number] => {
  const sorted = [...vector].sort((left, right) => right - left);
  let runningSum = 0;
  let threshold = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    runningSum += sorted[index] ?? 0;
    const candidateThreshold = (runningSum - 1) / (index + 1);
    const nextValue = sorted[index + 1];

    if (nextValue === undefined || nextValue <= candidateThreshold) {
      threshold = candidateThreshold;
      break;
    }
  }

  return [
    Math.max(vector[0] - threshold, 0),
    Math.max(vector[1] - threshold, 0),
    Math.max(vector[2] - threshold, 0),
  ];
};

const optimizeWeightsForSample = (
  validComponents: DistanceComponents[],
  invalidComponents: DistanceComponents[],
): OptimizationResult => {
  if (invalidComponents.length === 0) {
    const weights = {
      ratio: 1 / 3,
      angle: 1 / 3,
      z: 1 / 3,
    };

    return {
      weights,
      bestValidDistance: Math.min(
        ...validComponents.map((components) =>
          getWeightedDistance(components, weights),
        ),
      ),
      bestInvalidDistance: Number.POSITIVE_INFINITY,
      margin: Number.POSITIVE_INFINITY,
    };
  }

  const hessian: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const linear: [number, number, number] = [0, 0, 0];
  const pairWeight = 1 / (validComponents.length * invalidComponents.length);

  for (const valid of validComponents) {
    const validVector = getComponentVector(valid);

    for (const invalid of invalidComponents) {
      const invalidVector = getComponentVector(invalid);
      const differenceVector: [number, number, number] = [
        invalidVector[0] - validVector[0],
        invalidVector[1] - validVector[1],
        invalidVector[2] - validVector[2],
      ];

      for (const rowIndex of AXES) {
        linear[rowIndex] += 2 * pairWeight * differenceVector[rowIndex];

        for (const columnIndex of AXES) {
          hessian[rowIndex][columnIndex] +=
            2 *
            pairWeight *
            differenceVector[rowIndex] *
            differenceVector[columnIndex];
        }
      }
    }
  }

  for (const index of AXES) {
    hessian[index][index] += 2 * LEAST_SQUARES_REGULARIZATION;
  }

  const largestEigenvalue = getLargestEigenvalue(hessian);
  const stepSize = 1 / Math.max(largestEigenvalue, 1);
  let weightVector: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];

  for (
    let iteration = 0;
    iteration < LEAST_SQUARES_MAX_ITERATIONS;
    iteration += 1
  ) {
    const multiplied = multiplyMatrixVector(hessian, weightVector);
    const gradient: [number, number, number] = [
      multiplied[0] - linear[0],
      multiplied[1] - linear[1],
      multiplied[2] - linear[2],
    ];
    const nextWeightVector = projectToSimplex([
      weightVector[0] - stepSize * gradient[0],
      weightVector[1] - stepSize * gradient[1],
      weightVector[2] - stepSize * gradient[2],
    ]);
    const delta = Math.hypot(
      nextWeightVector[0] - weightVector[0],
      nextWeightVector[1] - weightVector[1],
      nextWeightVector[2] - weightVector[2],
    );

    weightVector = nextWeightVector;
    if (delta <= LEAST_SQUARES_TOLERANCE) {
      break;
    }
  }

  const weights = {
    ratio: weightVector[0],
    angle: weightVector[1],
    z: weightVector[2],
  };

  let bestValidDistance = Number.POSITIVE_INFINITY;
  for (const components of validComponents) {
    const distance = getWeightedDistance(components, weights);
    if (distance < bestValidDistance) {
      bestValidDistance = distance;
    }
  }

  let bestInvalidDistance = Number.POSITIVE_INFINITY;
  for (const components of invalidComponents) {
    const distance = getWeightedDistance(components, weights);
    if (distance < bestInvalidDistance) {
      bestInvalidDistance = distance;
    }
  }

  return {
    weights,
    bestValidDistance,
    bestInvalidDistance,
    margin: bestInvalidDistance - bestValidDistance,
  };
};

const loadSolveCacheEntries = async (pairCount: number) => {
  const cachePath = join(process.cwd(), `solve-cache-${pairCount}.json`);
  const cacheFile = Bun.file(cachePath);
  if (!(await cacheFile.exists())) {
    throw new Error(`Missing solve cache file ${cachePath}`);
  }

  const rawCache = await cacheFile.text();
  return parseSolveCacheFile(JSON.parse(rawCache), pairCount).entries;
};

const createSampleIndexGenerator = (pairCount: number) => {
  const random = createDeterministicRandom(
    getSampleSeed(pairCount * 10_000, 0x7d31_4b29),
  );

  return () => SAMPLE_INDEX_MIN + Math.floor(random() * SAMPLE_INDEX_RANGE);
};

const formatNumber = (value: number) => value.toFixed(2);

const printResultsHeader = (pairCount: number) => {
  console.log("");
  console.log(`Pair Count ${pairCount}`);
  console.log(
    [
      "sampleId".padEnd(16),
      "valid".padStart(7),
      "invalid".padStart(8),
      "ratioW".padStart(8),
      "angleW".padStart(8),
      "zW".padStart(6),
      "validDist".padStart(10),
      "invalidDist".padStart(12),
      "margin".padStart(10),
    ].join(" "),
  );
};

const printResultRow = (result: SampleCalibrationResult) => {
  console.log(
    [
      result.sampleId.padEnd(16),
      result.validCandidateCount.toString().padStart(7),
      result.invalidCandidateCount.toString().padStart(8),
      formatNumber(result.weights.ratio).padStart(8),
      formatNumber(result.weights.angle).padStart(8),
      formatNumber(result.weights.z).padStart(6),
      result.bestValidDistance.toFixed(4).padStart(10),
      result.bestInvalidDistance.toFixed(4).padStart(12),
      result.margin.toFixed(4).padStart(10),
    ].join(" "),
  );
};

const printAverageWeights = (results: SampleCalibrationResult[]) => {
  const averageWeights = getAverageWeights(results);
  console.log("");
  console.log(
    `Average Weights: ratio=${averageWeights.ratio.toFixed(4)} angle=${averageWeights.angle.toFixed(4)} z=${averageWeights.z.toFixed(4)}`,
  );
};

const writePartialResults = async (
  outputPath: string,
  pairCount: number,
  requestedSampleCount: number,
  results: SampleCalibrationResult[],
) => {
  const payload = {
    pairCount,
    requestedSampleCount,
    collectedSampleCount: results.length,
    averageWeights:
      results.length > 0 ? getAverageWeights(results) : { ratio: 0, angle: 0, z: 0 },
    results,
    updatedAt: new Date().toISOString(),
  };

  await Bun.write(outputPath, JSON.stringify(payload, null, 2));
};

const main = async () => {
  const argv = process.argv.slice(2);
  const pairCount = parseIntegerFlag(
    argv,
    ["--pair-count", "--pair-counts", "--point-pairs"],
    DEFAULT_PAIR_COUNT,
  );
  const sampleCount = parseIntegerFlag(
    argv,
    ["--sample-count"],
    DEFAULT_SAMPLE_COUNT,
  );
  const outputJsonPath = parseStringFlag(argv, ["--json-output"]);
  const maxAttempts = sampleCount * MAX_SAMPLE_ATTEMPTS_MULTIPLIER;
  const solveCacheEntries = await loadSolveCacheEntries(pairCount);
  const nextSampleIndex = createSampleIndexGenerator(pairCount);
  const results: SampleCalibrationResult[] = [];

  printResultsHeader(pairCount);

  for (
    let attempt = 0;
    attempt < maxAttempts && results.length < sampleCount;
    attempt += 1
  ) {
    const sampleIndex = nextSampleIndex();
    const sample = canonicalizeDatasetSample(
      createMatchSampleWithPairCount(sampleIndex, pairCount),
    );
    const candidates = getSolveCacheCandidates(sample, solveCacheEntries);
    const validComponents: DistanceComponents[] = [];
    const invalidComponents: DistanceComponents[] = [];

    for (const candidate of candidates) {
      const components = getDistanceComponents(
        sample.vecRaw ?? [],
        candidate.entry.vecRaw,
      );
      const result = diagnoseSolveCacheEntryApplication(
        sample,
        candidate.entry,
      );

      if (result.ok) {
        validComponents.push(components);
      } else {
        invalidComponents.push(components);
      }
    }

    if (validComponents.length === 0) {
      console.warn(
        `Skipping ${sample.capacityMeshNodeId}: no DRC-clean cache candidates out of ${candidates.length}`,
      );
      continue;
    }

    const optimization = optimizeWeightsForSample(
      validComponents,
      invalidComponents,
    );

    results.push({
      sampleIndex,
      sampleId: sample.capacityMeshNodeId,
      validCandidateCount: validComponents.length,
      invalidCandidateCount: invalidComponents.length,
      ...optimization,
    });

    const latestResult = results[results.length - 1]!;
    printResultRow(latestResult);

    if (outputJsonPath) {
      await writePartialResults(
        outputJsonPath,
        pairCount,
        sampleCount,
        results,
      );
    }
  }

  if (results.length === 0) {
    throw new Error(`No calibratable samples found for pairCount ${pairCount}`);
  }

  if (results.length < sampleCount) {
    console.warn(
      `Collected ${results.length} samples out of requested ${sampleCount} after ${maxAttempts} attempts`,
    );
  }

  printAverageWeights(results);

  if (outputJsonPath) {
    console.log(`Partial results written to ${outputJsonPath}`);
  }
};

main().catch((error) => {
  console.error("Failed to calibrate vector distance weights:", error);
  process.exit(1);
});
