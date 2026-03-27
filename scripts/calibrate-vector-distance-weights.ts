import { join } from "node:path";
import { createDeterministicRandom, getSampleSeed } from "../lib/generator";
import {
  canonicalizeDatasetSample,
  diagnoseSolveCacheEntryApplication,
  getSolveCacheCandidates,
  parseSolveCacheFile,
  type SolveCacheCandidate,
  type SolveCacheEntry,
} from "../lib/solve-cache";
import type { DatasetSample } from "../lib/types";
import { canonicalizeRawVecStructure } from "../lib/vector-search";

const DEFAULT_PAIR_COUNT = 2;
const DEFAULT_TOP_K = 16;
const DEFAULT_MAX_PROBE_RANK = 64;
const DEFAULT_EPOCHS = 8;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_LEARNING_RATE = 0.05;
const DEFAULT_MARGIN_TEMPERATURE = 0.1;
const WEIGHT_REGULARIZATION = 0.001;
const UPDATE_EPSILON = 1e-9;
const TAU = Math.PI * 2;
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

type TrainingCandidate = {
  sourceEntryIndex: number;
  symmetry: SolveCacheCandidate["symmetry"];
  entry: SolveCacheEntry;
  components: DistanceComponents;
};

type TrainingSample = {
  sampleId: string;
  targetEntryIndex: number;
  sample: DatasetSample;
  candidates: TrainingCandidate[];
};

type EpochMetrics = {
  epoch: number;
  hits: number;
  totalSamples: number;
  availableSamples: number;
  accuracy: number;
  avgFirstPassRank: number | null;
  updates: number;
  gradientSamples: number;
  avgLoss: number | null;
  drcChecksPerformed: number;
  drcChecksCached: number;
  weights: WeightTriple;
};

type DrcCacheValue = {
  ok: boolean;
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

const parseFloatFlag = (
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
    const parsedValue = Number.parseFloat(rawValue ?? "");
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

const formatWeights = (weights: WeightTriple) =>
  `ratio=${weights.ratio.toFixed(4)} angle=${weights.angle.toFixed(4)} z=${weights.z.toFixed(4)}`;

const loadSolveCacheEntries = async (pairCount: number) => {
  const cachePath = join(process.cwd(), `solve-cache-${pairCount}.json`);
  const cacheFile = Bun.file(cachePath);
  if (!(await cacheFile.exists())) {
    throw new Error(`Missing solve cache file ${cachePath}`);
  }

  const rawCache = await cacheFile.text();
  return parseSolveCacheFile(JSON.parse(rawCache), pairCount).entries;
};

const getDatasetSampleFromEntry = (entry: SolveCacheEntry): DatasetSample =>
  canonicalizeDatasetSample({
    ...entry.sample,
    solvable: false,
    solution: null,
  });

const shuffleInPlace = <T>(items: T[], random: () => number) => {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
};

const getLogisticLoss = (margin: number, temperature: number) => {
  const scaled = -margin / temperature;
  return scaled > 0
    ? scaled + Math.log1p(Math.exp(-scaled))
    : Math.log1p(Math.exp(scaled));
};

const getLogisticGradientScale = (margin: number, temperature: number) =>
  -1 / (temperature * (1 + Math.exp(margin / temperature)));

const createTrainingSamples = (entries: SolveCacheEntry[]) =>
  entries.map((targetEntry, targetEntryIndex) => {
    const sample = getDatasetSampleFromEntry(targetEntry);
    const vecRaw = sample.vecRaw ?? [];
    const candidates = getSolveCacheCandidates(sample, entries)
      .filter((candidate) => candidate.sourceEntry !== targetEntry)
      .map((candidate) => ({
        sourceEntryIndex: entries.indexOf(candidate.sourceEntry),
        symmetry: candidate.symmetry,
        entry: candidate.entry,
        components: getDistanceComponents(vecRaw, candidate.entry.vecRaw),
      }));

    return {
      sampleId: sample.capacityMeshNodeId,
      targetEntryIndex,
      sample,
      candidates,
    } satisfies TrainingSample;
  });

const getDrcCacheKey = (
  targetEntryIndex: number,
  candidate: TrainingCandidate,
) =>
  `${targetEntryIndex}:${candidate.sourceEntryIndex}:${candidate.symmetry}`;

const getCandidateVerdict = (
  trainingSample: TrainingSample,
  candidate: TrainingCandidate,
  drcCache: Map<string, DrcCacheValue>,
  drcStats: { performed: number; cached: number },
) => {
  const cacheKey = getDrcCacheKey(trainingSample.targetEntryIndex, candidate);
  const cachedVerdict = drcCache.get(cacheKey);
  if (cachedVerdict) {
    drcStats.cached += 1;
    return cachedVerdict.ok;
  }

  const result = diagnoseSolveCacheEntryApplication(
    trainingSample.sample,
    candidate.entry,
  );
  const value = { ok: result.ok };
  drcCache.set(cacheKey, value);
  drcStats.performed += 1;
  return value.ok;
};

const rankCandidates = (
  candidates: TrainingCandidate[],
  weights: WeightTriple,
) =>
  [...candidates].sort(
    (left, right) =>
      getWeightedDistance(left.components, weights) -
      getWeightedDistance(right.components, weights),
  );

const getTrainingSignal = (
  trainingSample: TrainingSample,
  rankedCandidates: TrainingCandidate[],
  topK: number,
  maxProbeRank: number,
  drcCache: Map<string, DrcCacheValue>,
  drcStats: { performed: number; cached: number },
) => {
  const topCandidates = rankedCandidates.slice(0, Math.min(topK, rankedCandidates.length));
  const topVerdicts = topCandidates.map((candidate) =>
    getCandidateVerdict(trainingSample, candidate, drcCache, drcStats),
  );
  const firstPassIndex = topVerdicts.findIndex(Boolean);

  if (firstPassIndex !== -1) {
    return {
      hit: true,
      firstPassRank: firstPassIndex + 1,
      positiveCandidate: topCandidates[firstPassIndex]!,
      negativeCandidates: topCandidates.filter(
        (_candidate, index) => !topVerdicts[index] && index < firstPassIndex,
      ),
    };
  }

  const probeLimit = Math.min(maxProbeRank, rankedCandidates.length);
  let positiveCandidate: TrainingCandidate | null = null;

  for (let rankIndex = topCandidates.length; rankIndex < probeLimit; rankIndex += 1) {
    const candidate = rankedCandidates[rankIndex]!;
    const ok = getCandidateVerdict(trainingSample, candidate, drcCache, drcStats);
    if (ok) {
      positiveCandidate = candidate;
      break;
    }
  }

  return {
    hit: false,
    firstPassRank: null,
    positiveCandidate,
    negativeCandidates: topCandidates,
  };
};

const getSampleGradientAndLoss = (
  weights: WeightTriple,
  positiveCandidate: TrainingCandidate,
  negativeCandidates: TrainingCandidate[],
  temperature: number,
) => {
  if (negativeCandidates.length === 0) {
    return {
      gradient: [0, 0, 0] as [number, number, number],
      loss: 0,
    };
  }

  const gradient: [number, number, number] = [0, 0, 0];
  let loss = 0;

  const pairWeight = 1 / negativeCandidates.length;

  for (const negativeCandidate of negativeCandidates) {
    const difference = {
      ratio: negativeCandidate.components.ratio - positiveCandidate.components.ratio,
      angle: negativeCandidate.components.angle - positiveCandidate.components.angle,
      z: negativeCandidate.components.z - positiveCandidate.components.z,
    };
    const margin = getWeightedDistance(difference, {
      ratio: weights.ratio,
      angle: weights.angle,
      z: weights.z,
    });
    const gradientScale =
      pairWeight * getLogisticGradientScale(margin, temperature);

    gradient[0] += gradientScale * difference.ratio;
    gradient[1] += gradientScale * difference.angle;
    gradient[2] += gradientScale * difference.z;
    loss += pairWeight * getLogisticLoss(margin, temperature);
  }

  return {
    gradient,
    loss,
  };
};

const writePartialResults = async (
  outputPath: string,
  pairCount: number,
  cacheSize: number,
  topK: number,
  maxProbeRank: number,
  epochHistory: EpochMetrics[],
  weights: WeightTriple,
) => {
  const payload = {
    pairCount,
    cacheSize,
    topK,
    maxProbeRank,
    epochHistory,
    finalWeights: weights,
    updatedAt: new Date().toISOString(),
  };

  await Bun.write(outputPath, JSON.stringify(payload, null, 2));
};

const trainWeights = async (
  trainingSamples: TrainingSample[],
  epochs: number,
  batchSize: number,
  topK: number,
  maxProbeRank: number,
  learningRate: number,
  temperature: number,
  outputJsonPath: string | null,
  pairCount: number,
) => {
  let weights: WeightTriple = {
    ratio: 1 / 3,
    angle: 1 / 3,
    z: 1 / 3,
  };
  const drcCache = new Map<string, DrcCacheValue>();
  const epochHistory: EpochMetrics[] = [];
  const shuffledSamples = [...trainingSamples];
  const random = createDeterministicRandom(getSampleSeed(pairCount, 0x5e11_7d91));

  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    shuffleInPlace(shuffledSamples, random);
    const epochSamples = shuffledSamples.slice(
      0,
      Math.min(batchSize, shuffledSamples.length),
    );
    let hits = 0;
    let accumulatedLoss = 0;
    let lossCount = 0;
    let gradientSamples = 0;
    let firstPassRankTotal = 0;
    let firstPassRankCount = 0;
    const drcStats = { performed: 0, cached: 0 };
    const batchGradient: [number, number, number] = [0, 0, 0];

    const epochLearningRate = learningRate / Math.sqrt(epoch);

    for (const trainingSample of epochSamples) {
      const rankedCandidates = rankCandidates(trainingSample.candidates, weights);
      const signal = getTrainingSignal(
        trainingSample,
        rankedCandidates,
        topK,
        maxProbeRank,
        drcCache,
        drcStats,
      );

      if (signal.hit) {
        hits += 1;
        if (signal.firstPassRank !== null) {
          firstPassRankTotal += signal.firstPassRank;
          firstPassRankCount += 1;
        }
      }

      if (!signal.positiveCandidate) {
        continue;
      }

      const sampleGradient = getSampleGradientAndLoss(
        weights,
        signal.positiveCandidate,
        signal.negativeCandidates,
        temperature,
      );
      batchGradient[0] += sampleGradient.gradient[0];
      batchGradient[1] += sampleGradient.gradient[1];
      batchGradient[2] += sampleGradient.gradient[2];
      accumulatedLoss += sampleGradient.loss;
      lossCount += 1;
      gradientSamples += 1;
    }

    let updates = 0;

    if (gradientSamples > 0) {
      const averagedGradient: [number, number, number] = [
        batchGradient[0] / gradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.ratio - 1 / 3),
        batchGradient[1] / gradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.angle - 1 / 3),
        batchGradient[2] / gradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.z - 1 / 3),
      ];
      const nextWeightVector = projectToSimplex([
        weights.ratio - epochLearningRate * averagedGradient[0],
        weights.angle - epochLearningRate * averagedGradient[1],
        weights.z - epochLearningRate * averagedGradient[2],
      ]);
      const nextWeights = {
        ratio: nextWeightVector[0],
        angle: nextWeightVector[1],
        z: nextWeightVector[2],
      };
      const weightDelta =
        Math.abs(nextWeights.ratio - weights.ratio) +
        Math.abs(nextWeights.angle - weights.angle) +
        Math.abs(nextWeights.z - weights.z);

      weights = nextWeights;
      if (weightDelta > UPDATE_EPSILON) {
        updates = 1;
      }
    }

    const metrics: EpochMetrics = {
      epoch,
      hits,
      totalSamples: epochSamples.length,
      availableSamples: trainingSamples.length,
      accuracy: hits / epochSamples.length,
      avgFirstPassRank:
        firstPassRankCount > 0 ? firstPassRankTotal / firstPassRankCount : null,
      updates,
      gradientSamples,
      avgLoss: lossCount > 0 ? accumulatedLoss / lossCount : null,
      drcChecksPerformed: drcStats.performed,
      drcChecksCached: drcStats.cached,
      weights,
    };

    epochHistory.push(metrics);
    console.log(
      [
        `epoch=${metrics.epoch.toString().padStart(2)}`,
        `hits=${metrics.hits}/${metrics.totalSamples}`,
        `batch=${metrics.totalSamples}/${metrics.availableSamples}`,
        `accuracy=${metrics.accuracy.toFixed(4)}`,
        `avgFirstPassRank=${
          metrics.avgFirstPassRank === null
            ? "n/a"
            : metrics.avgFirstPassRank.toFixed(2)
        }`,
        `updates=${metrics.updates}`,
        `signals=${metrics.gradientSamples}`,
        `avgLoss=${metrics.avgLoss === null ? "n/a" : metrics.avgLoss.toFixed(4)}`,
        `drcChecked=${metrics.drcChecksPerformed}`,
        `drcCached=${metrics.drcChecksCached}`,
        formatWeights(metrics.weights),
      ].join(" "),
    );

    if (outputJsonPath) {
      await writePartialResults(
        outputJsonPath,
        pairCount,
        trainingSamples.length,
        topK,
        maxProbeRank,
        epochHistory,
        weights,
      );
    }
  }

  return {
    weights,
    epochHistory,
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const pairCount = parseIntegerFlag(
    argv,
    ["--pair-count", "--pair-counts", "--point-pairs"],
    DEFAULT_PAIR_COUNT,
  );
  const epochs = parseIntegerFlag(argv, ["--epochs"], DEFAULT_EPOCHS);
  const batchSize = parseIntegerFlag(
    argv,
    ["--batch-size"],
    DEFAULT_BATCH_SIZE,
  );
  const topK = parseIntegerFlag(argv, ["--top-k"], DEFAULT_TOP_K);
  const maxProbeRank = parseIntegerFlag(
    argv,
    ["--max-probe-rank"],
    DEFAULT_MAX_PROBE_RANK,
  );
  const learningRate = parseFloatFlag(
    argv,
    ["--learning-rate"],
    DEFAULT_LEARNING_RATE,
  );
  const temperature = parseFloatFlag(
    argv,
    ["--temperature"],
    DEFAULT_MARGIN_TEMPERATURE,
  );
  const outputJsonPath = parseStringFlag(argv, ["--json-output"]);

  if (maxProbeRank < topK) {
    throw new Error(
      `--max-probe-rank (${maxProbeRank}) must be >= --top-k (${topK})`,
    );
  }

  const entries = await loadSolveCacheEntries(pairCount);
  const trainingSamples = createTrainingSamples(entries);

  console.log(
    `Loaded ${trainingSamples.length} cache samples for pairCount=${pairCount} batchSize=${Math.min(batchSize, trainingSamples.length)} topK=${topK} maxProbeRank=${maxProbeRank} epochs=${epochs}`,
  );

  const { weights, epochHistory } = await trainWeights(
    trainingSamples,
    epochs,
    batchSize,
    topK,
    maxProbeRank,
    learningRate,
    temperature,
    outputJsonPath,
    pairCount,
  );

  const lastEpoch = epochHistory[epochHistory.length - 1];
  console.log("");
  console.log(`Final Weights: ${formatWeights(weights)}`);
  if (lastEpoch) {
    console.log(
      `Final Accuracy: ${lastEpoch.hits}/${lastEpoch.totalSamples} (${lastEpoch.accuracy.toFixed(4)})`,
    );
  }
};

main().catch((error) => {
  console.error("Failed to calibrate vector distance weights:", error);
  process.exit(1);
});
