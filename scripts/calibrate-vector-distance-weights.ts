import { join } from "node:path";
import { createDeterministicRandom, getSampleSeed } from "../lib/generator";
import {
  DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY,
  canonicalizeDatasetSample,
  diagnoseSolveCacheEntryApplication,
  getSolveCacheCandidates,
  parseSolveCacheFile,
  type SolveCacheCandidate,
  type SolveCacheEntry,
} from "../lib/solve-cache";
import type { DatasetSample } from "../lib/types";
import { computeVecRaw } from "../lib/vec-raw";
import {
  canonicalizeRawVecStructure,
  getRawVecHeaderLength,
} from "../lib/vector-search";

const DEFAULT_PAIR_COUNT = 2;
const DEFAULT_TOP_K = DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY;
const DEFAULT_MAX_PROBE_RANK = 64;
const DEFAULT_EPOCHS = 32;
const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_LEARNING_RATE = 0.05;
const DEFAULT_MARGIN_TEMPERATURE = 0.1;
const WEIGHT_REGULARIZATION = 0.001;
const UPDATE_EPSILON = 1e-9;
const WEIGHT_COMPONENT_COUNT = 6;
const UNIFORM_WEIGHT = 1 / WEIGHT_COMPONENT_COUNT;

type WeightVector = {
  ratio: number;
  sameZIntersections: number;
  differentZIntersections: number;
  entryExitZChanges: number;
  z: number;
  distWeight: number;
};

type WeightLogits = {
  ratio: number;
  sameZIntersections: number;
  differentZIntersections: number;
  entryExitZChanges: number;
  z: number;
  distWeight: number;
};

type DistanceComponents = {
  ratio: number;
  sameZIntersections: number;
  differentZIntersections: number;
  entryExitZChanges: number;
  z: number;
  dist: number;
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
  evaluationAccuracy: number;
  evaluationAvgFirstPassRank: number | null;
  bestAccuracy: number;
  bestAvgFirstPassRank: number | null;
  weights: WeightVector;
};

type EvaluationMetrics = {
  hits: number;
  totalSamples: number;
  accuracy: number;
  avgFirstPassRank: number | null;
  drcChecksPerformed: number;
  drcChecksCached: number;
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

const logitsToWeights = (logits: WeightLogits): WeightVector => {
  const maxLogit = Math.max(
    logits.ratio,
    logits.sameZIntersections,
    logits.differentZIntersections,
    logits.entryExitZChanges,
    logits.z,
    logits.distWeight,
  );
  const ratioExp = Math.exp(logits.ratio - maxLogit);
  const sameZIntersectionsExp = Math.exp(
    logits.sameZIntersections - maxLogit,
  );
  const differentZIntersectionsExp = Math.exp(
    logits.differentZIntersections - maxLogit,
  );
  const entryExitZChangesExp = Math.exp(
    logits.entryExitZChanges - maxLogit,
  );
  const zExp = Math.exp(logits.z - maxLogit);
  const distExp = Math.exp(logits.distWeight - maxLogit);
  const total =
    ratioExp +
    sameZIntersectionsExp +
    differentZIntersectionsExp +
    entryExitZChangesExp +
    zExp +
    distExp;

  return {
    ratio: ratioExp / total,
    sameZIntersections: sameZIntersectionsExp / total,
    differentZIntersections: differentZIntersectionsExp / total,
    entryExitZChanges: entryExitZChangesExp / total,
    z: zExp / total,
    distWeight: distExp / total,
  };
};

const centerLogits = (logits: WeightLogits): WeightLogits => {
  const mean =
    (logits.ratio +
      logits.sameZIntersections +
      logits.differentZIntersections +
      logits.entryExitZChanges +
      logits.z +
      logits.distWeight) /
    WEIGHT_COMPONENT_COUNT;

  return {
    ratio: logits.ratio - mean,
    sameZIntersections: logits.sameZIntersections - mean,
    differentZIntersections: logits.differentZIntersections - mean,
    entryExitZChanges: logits.entryExitZChanges - mean,
    z: logits.z - mean,
    distWeight: logits.distWeight - mean,
  };
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
  const headerLength = getRawVecHeaderLength(left) ?? 1;
  const ratioDelta = (left[0] ?? 0) - (right[0] ?? 0);
  const sameZIntersectionsDelta =
    headerLength >= 4 ? (left[1] ?? 0) - (right[1] ?? 0) : 0;
  const differentZIntersectionsDelta =
    headerLength >= 4 ? (left[2] ?? 0) - (right[2] ?? 0) : 0;
  const entryExitZChangesDelta =
    headerLength >= 4 ? (left[3] ?? 0) - (right[3] ?? 0) : 0;

  let z = 0;
  let dist = 0;

  for (let index = headerLength; index < left.length; index += 4) {
    const zDelta = (left[index + 1] ?? 0) - (right[index + 1] ?? 0);
    const xDelta = (left[index + 2] ?? 0) - (right[index + 2] ?? 0);
    const yDelta = (left[index + 3] ?? 0) - (right[index + 3] ?? 0);

    z += zDelta * zDelta;
    dist += xDelta * xDelta + yDelta * yDelta;
  }

  return {
    ratio: ratioDelta * ratioDelta,
    sameZIntersections: sameZIntersectionsDelta * sameZIntersectionsDelta,
    differentZIntersections:
      differentZIntersectionsDelta * differentZIntersectionsDelta,
    entryExitZChanges: entryExitZChangesDelta * entryExitZChangesDelta,
    z,
    dist,
  };
};

const getWeightedDistance = (
  components: DistanceComponents,
  weights: WeightVector,
) =>
  components.ratio * weights.ratio +
  components.sameZIntersections * weights.sameZIntersections +
  components.differentZIntersections * weights.differentZIntersections +
  components.entryExitZChanges * weights.entryExitZChanges +
  components.z * weights.z +
  components.dist * weights.distWeight;

const formatWeights = (weights: WeightVector) =>
  [
    `ratio=${weights.ratio.toFixed(4)}`,
    `sameZIntersections=${weights.sameZIntersections.toFixed(4)}`,
    `differentZIntersections=${weights.differentZIntersections.toFixed(4)}`,
    `entryExitZChanges=${weights.entryExitZChanges.toFixed(4)}`,
    `z=${weights.z.toFixed(4)}`,
    `distWeight=${weights.distWeight.toFixed(4)}`,
  ].join(" ");

const isEvaluationBetter = (
  candidate: EvaluationMetrics,
  incumbent: EvaluationMetrics,
) => {
  if (candidate.accuracy !== incumbent.accuracy) {
    return candidate.accuracy > incumbent.accuracy;
  }

  const candidateRank = candidate.avgFirstPassRank ?? Number.POSITIVE_INFINITY;
  const incumbentRank = incumbent.avgFirstPassRank ?? Number.POSITIVE_INFINITY;

  if (candidateRank !== incumbentRank) {
    return candidateRank < incumbentRank;
  }

  return candidate.hits > incumbent.hits;
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
    const vecRaw = computeVecRaw(sample);
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
) => `${targetEntryIndex}:${candidate.sourceEntryIndex}:${candidate.symmetry}`;

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
  weights: WeightVector,
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
  const topCandidates = rankedCandidates.slice(
    0,
    Math.min(topK, rankedCandidates.length),
  );
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

  for (
    let rankIndex = topCandidates.length;
    rankIndex < probeLimit;
    rankIndex += 1
  ) {
    const candidate = rankedCandidates[rankIndex]!;
    const ok = getCandidateVerdict(
      trainingSample,
      candidate,
      drcCache,
      drcStats,
    );
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
  weights: WeightVector,
  positiveCandidate: TrainingCandidate,
  negativeCandidates: TrainingCandidate[],
  temperature: number,
) => {
  if (negativeCandidates.length === 0) {
    return {
      gradient: [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number],
      loss: 0,
    };
  }

  const gradient: [number, number, number, number, number, number] = [
    0, 0, 0, 0, 0, 0,
  ];
  let loss = 0;

  const pairWeight = 1 / negativeCandidates.length;

  for (const negativeCandidate of negativeCandidates) {
    const difference = {
      ratio:
        negativeCandidate.components.ratio - positiveCandidate.components.ratio,
      sameZIntersections:
        negativeCandidate.components.sameZIntersections -
        positiveCandidate.components.sameZIntersections,
      differentZIntersections:
        negativeCandidate.components.differentZIntersections -
        positiveCandidate.components.differentZIntersections,
      entryExitZChanges:
        negativeCandidate.components.entryExitZChanges -
        positiveCandidate.components.entryExitZChanges,
      z: negativeCandidate.components.z - positiveCandidate.components.z,
      dist:
        negativeCandidate.components.dist - positiveCandidate.components.dist,
    };
    const margin = getWeightedDistance(difference, {
      ratio: weights.ratio,
      sameZIntersections: weights.sameZIntersections,
      differentZIntersections: weights.differentZIntersections,
      entryExitZChanges: weights.entryExitZChanges,
      z: weights.z,
      distWeight: weights.distWeight,
    });
    const gradientScale =
      pairWeight * getLogisticGradientScale(margin, temperature);

    gradient[0] += gradientScale * difference.ratio;
    gradient[1] += gradientScale * difference.sameZIntersections;
    gradient[2] += gradientScale * difference.differentZIntersections;
    gradient[3] += gradientScale * difference.entryExitZChanges;
    gradient[4] += gradientScale * difference.z;
    gradient[5] += gradientScale * difference.dist;
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
  latestWeights: WeightVector,
  latestEvaluation?: EvaluationMetrics,
  bestWeights?: WeightVector,
  bestEvaluation?: EvaluationMetrics,
) => {
  const payload = {
    pairCount,
    cacheSize,
    topK,
    maxProbeRank,
    epochHistory,
    finalWeights: bestWeights ?? latestWeights,
    latestWeights,
    ...(latestEvaluation === undefined ? {} : { latestEvaluation }),
    ...(bestWeights === undefined ? {} : { bestWeights }),
    ...(bestEvaluation === undefined ? {} : { bestEvaluation }),
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
  let logits: WeightLogits = {
    ratio: 0,
    sameZIntersections: 0,
    differentZIntersections: 0,
    entryExitZChanges: 0,
    z: 0,
    distWeight: 0,
  };
  let weights = logitsToWeights(logits);
  const drcCache = new Map<string, DrcCacheValue>();
  const epochHistory: EpochMetrics[] = [];
  const shuffledSamples = [...trainingSamples];
  const random = createDeterministicRandom(
    getSampleSeed(pairCount, 0x5e11_7d91),
  );
  let bestWeights: WeightVector = { ...weights };
  let bestEvaluation: EvaluationMetrics | null = null;

  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    shuffleInPlace(shuffledSamples, random);
    let hits = 0;
    let accumulatedLoss = 0;
    let lossCount = 0;
    let gradientSamples = 0;
    let firstPassRankTotal = 0;
    let firstPassRankCount = 0;
    const drcStats = { performed: 0, cached: 0 };
    const epochLearningRate = learningRate / Math.sqrt(epoch);
    let updates = 0;

    for (
      let batchStart = 0;
      batchStart < shuffledSamples.length;
      batchStart += batchSize
    ) {
      const epochBatch = shuffledSamples.slice(
        batchStart,
        Math.min(batchStart + batchSize, shuffledSamples.length),
      );
      const batchGradient: [number, number, number, number, number, number] = [
        0, 0, 0, 0, 0, 0,
      ];
      let batchGradientSamples = 0;

      for (const trainingSample of epochBatch) {
        const rankedCandidates = rankCandidates(
          trainingSample.candidates,
          weights,
        );
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
        batchGradient[3] += sampleGradient.gradient[3];
        batchGradient[4] += sampleGradient.gradient[4];
        batchGradient[5] += sampleGradient.gradient[5];
        accumulatedLoss += sampleGradient.loss;
        lossCount += 1;
        gradientSamples += 1;
        batchGradientSamples += 1;
      }

      if (batchGradientSamples === 0) {
        continue;
      }

      const averagedGradient: [number, number, number, number, number, number] = [
        batchGradient[0] / batchGradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.ratio - UNIFORM_WEIGHT),
        batchGradient[1] / batchGradientSamples +
          2 *
            WEIGHT_REGULARIZATION *
            (weights.sameZIntersections - UNIFORM_WEIGHT),
        batchGradient[2] / batchGradientSamples +
          2 *
            WEIGHT_REGULARIZATION *
            (weights.differentZIntersections - UNIFORM_WEIGHT),
        batchGradient[3] / batchGradientSamples +
          2 *
            WEIGHT_REGULARIZATION *
            (weights.entryExitZChanges - UNIFORM_WEIGHT),
        batchGradient[4] / batchGradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.z - UNIFORM_WEIGHT),
        batchGradient[5] / batchGradientSamples +
          2 * WEIGHT_REGULARIZATION * (weights.distWeight - UNIFORM_WEIGHT),
      ];

      const gradientDotWeights =
        weights.ratio * averagedGradient[0] +
        weights.sameZIntersections * averagedGradient[1] +
        weights.differentZIntersections * averagedGradient[2] +
        weights.entryExitZChanges * averagedGradient[3] +
        weights.z * averagedGradient[4] +
        weights.distWeight * averagedGradient[5];
      const logitsGradient: WeightLogits = {
        ratio: weights.ratio * (averagedGradient[0] - gradientDotWeights),
        sameZIntersections:
          weights.sameZIntersections *
          (averagedGradient[1] - gradientDotWeights),
        differentZIntersections:
          weights.differentZIntersections *
          (averagedGradient[2] - gradientDotWeights),
        entryExitZChanges:
          weights.entryExitZChanges *
          (averagedGradient[3] - gradientDotWeights),
        z: weights.z * (averagedGradient[4] - gradientDotWeights),
        distWeight:
          weights.distWeight * (averagedGradient[5] - gradientDotWeights),
      };
      const nextLogits = centerLogits({
        ratio: logits.ratio - epochLearningRate * logitsGradient.ratio,
        sameZIntersections:
          logits.sameZIntersections -
          epochLearningRate * logitsGradient.sameZIntersections,
        differentZIntersections:
          logits.differentZIntersections -
          epochLearningRate * logitsGradient.differentZIntersections,
        entryExitZChanges:
          logits.entryExitZChanges -
          epochLearningRate * logitsGradient.entryExitZChanges,
        z: logits.z - epochLearningRate * logitsGradient.z,
        distWeight:
          logits.distWeight - epochLearningRate * logitsGradient.distWeight,
      });
      const nextWeights = logitsToWeights(nextLogits);
      const weightDelta =
        Math.abs(nextWeights.ratio - weights.ratio) +
        Math.abs(
          nextWeights.sameZIntersections - weights.sameZIntersections,
        ) +
        Math.abs(
          nextWeights.differentZIntersections - weights.differentZIntersections,
        ) +
        Math.abs(
          nextWeights.entryExitZChanges - weights.entryExitZChanges,
        ) +
        Math.abs(nextWeights.z - weights.z) +
        Math.abs(nextWeights.distWeight - weights.distWeight);

      logits = nextLogits;
      weights = nextWeights;
      if (weightDelta > UPDATE_EPSILON) {
        updates += 1;
      };
    }

    const evaluation = evaluateWeights(
      trainingSamples,
      weights,
      topK,
      maxProbeRank,
      drcCache,
    );

    if (
      bestEvaluation === null ||
      isEvaluationBetter(evaluation, bestEvaluation)
    ) {
      bestWeights = { ...weights };
      bestEvaluation = evaluation;
    }

    const metrics: EpochMetrics = {
      epoch,
      hits,
      totalSamples: shuffledSamples.length,
      availableSamples: trainingSamples.length,
      accuracy: hits / shuffledSamples.length,
      avgFirstPassRank:
        firstPassRankCount > 0 ? firstPassRankTotal / firstPassRankCount : null,
      updates,
      gradientSamples,
      avgLoss: lossCount > 0 ? accumulatedLoss / lossCount : null,
      drcChecksPerformed: drcStats.performed,
      drcChecksCached: drcStats.cached,
      evaluationAccuracy: evaluation.accuracy,
      evaluationAvgFirstPassRank: evaluation.avgFirstPassRank,
      bestAccuracy: bestEvaluation?.accuracy ?? evaluation.accuracy,
      bestAvgFirstPassRank:
        bestEvaluation?.avgFirstPassRank ?? evaluation.avgFirstPassRank,
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
        `evalAccuracy=${metrics.evaluationAccuracy.toFixed(4)}`,
        `evalAvgFirstPassRank=${
          metrics.evaluationAvgFirstPassRank === null
            ? "n/a"
            : metrics.evaluationAvgFirstPassRank.toFixed(2)
        }`,
        `bestAccuracy=${metrics.bestAccuracy.toFixed(4)}`,
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
        evaluation,
        bestWeights,
        bestEvaluation,
      );
    }
  }

  return {
    weights: bestWeights,
    epochHistory,
    bestEvaluation:
      bestEvaluation ??
      evaluateWeights(trainingSamples, bestWeights, topK, maxProbeRank, drcCache),
  };
};

const evaluateWeights = (
  trainingSamples: TrainingSample[],
  weights: WeightVector,
  topK: number,
  maxProbeRank: number,
  drcCache: Map<string, DrcCacheValue> = new Map(),
): EvaluationMetrics => {
  const drcStats = { performed: 0, cached: 0 };
  let hits = 0;
  let firstPassRankTotal = 0;
  let firstPassRankCount = 0;

  for (const trainingSample of trainingSamples) {
    const rankedCandidates = rankCandidates(trainingSample.candidates, weights);
    const signal = getTrainingSignal(
      trainingSample,
      rankedCandidates,
      topK,
      maxProbeRank,
      drcCache,
      drcStats,
    );

    if (!signal.hit) {
      continue;
    }

    hits += 1;
    if (signal.firstPassRank !== null) {
      firstPassRankTotal += signal.firstPassRank;
      firstPassRankCount += 1;
    }
  }

  return {
    hits,
    totalSamples: trainingSamples.length,
    accuracy: hits / trainingSamples.length,
    avgFirstPassRank:
      firstPassRankCount > 0 ? firstPassRankTotal / firstPassRankCount : null,
    drcChecksPerformed: drcStats.performed,
    drcChecksCached: drcStats.cached,
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

  const { weights, epochHistory, bestEvaluation } = await trainWeights(
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

  if (outputJsonPath) {
    await writePartialResults(
      outputJsonPath,
      pairCount,
      trainingSamples.length,
      topK,
      maxProbeRank,
      epochHistory,
      weights,
      bestEvaluation,
      weights,
      bestEvaluation,
    );
  }

  console.log("");
  console.log(`Final Weights: ${formatWeights(weights)}`);
  console.log(
    `Final Accuracy: ${bestEvaluation.hits}/${bestEvaluation.totalSamples} (${bestEvaluation.accuracy.toFixed(4)})`,
  );
  console.log(
    `Final AvgFirstPassRank: ${
      bestEvaluation.avgFirstPassRank === null
        ? "n/a"
        : bestEvaluation.avgFirstPassRank.toFixed(2)
    }`,
  );
};

main().catch((error) => {
  console.error("Failed to calibrate vector distance weights:", error);
  process.exit(1);
});
