import { join } from "node:path";
import {
  createDeterministicRandom,
  getSampleSeed,
} from "../lib/generator";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import {
  DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY,
  SOLVE_CACHE_SYMMETRIES,
  canonicalizeDatasetSample,
  diagnoseSolveCacheEntryApplication,
  findSolveCacheMatch,
  getSolveCacheEntrySymmetryVariant,
  parseSolveCacheFile,
  type SolveCacheEntry,
  type SolveCacheSymmetry,
} from "../lib/solve-cache";
import {
  VECTOR_DISTANCE_WEIGHTS,
  canonicalizeRawVecStructure,
  getRawVecHeaderLength,
} from "../lib/vector-search";

const DEFAULT_PAIR_COUNT = 4;
const DEFAULT_SAMPLE_COUNT = 100_000;
const DEFAULT_START_INDEX = 1_000_000;
const DEFAULT_TOP_K = DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY;
const DEFAULT_PROGRESS_EVERY = 1_000;
const DEFAULT_VERIFY_COUNT = 100;
const BENCHMARK_DATASET_SEED = 0x4f2c_9d31;

type VecFeatures = {
  ratio: number;
  sameZIntersections: number;
  differentZIntersections: number;
  entryExitZChanges: number;
  zValues: Uint8Array;
  xyValues: Float64Array;
  zSignature: string;
};

type BenchmarkVariant = {
  ordinal: number;
  sourceEntryIndex: number;
  symmetry: SolveCacheSymmetry;
  entry: SolveCacheEntry;
  features: VecFeatures;
};

type BenchmarkBucket = {
  zSignature: string;
  zValues: Uint8Array;
  variants: BenchmarkVariant[];
};

type RankedCandidate = {
  variant: BenchmarkVariant;
  distance: number;
};

type MatchSummary = {
  hit: boolean;
  firstPassRank: number | null;
};

type BenchmarkStats = {
  hits: number;
  misses: number;
  firstPassRankSum: number;
  firstPassRankCount: number;
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

const extractVecFeatures = (vector: number[]): VecFeatures => {
  const canonicalVec = canonicalizeRawVecStructure(vector);
  const headerLength = getRawVecHeaderLength(canonicalVec) ?? 1;
  const zValues: number[] = [];
  const xyValues: number[] = [];

  for (let index = headerLength; index < canonicalVec.length; index += 4) {
    zValues.push(canonicalVec[index + 1] ?? 0);
    xyValues.push(canonicalVec[index + 2] ?? 0, canonicalVec[index + 3] ?? 0);
  }

  return {
    ratio: canonicalVec[0] ?? 0,
    sameZIntersections: headerLength >= 4 ? (canonicalVec[1] ?? 0) : 0,
    differentZIntersections: headerLength >= 4 ? (canonicalVec[2] ?? 0) : 0,
    entryExitZChanges: headerLength >= 4 ? (canonicalVec[3] ?? 0) : 0,
    zValues: Uint8Array.from(zValues),
    xyValues: Float64Array.from(xyValues),
    zSignature: zValues.join(""),
  };
};

const getHammingDistance = (left: Uint8Array, right: Uint8Array) => {
  let distance = 0;

  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      distance += 1;
    }
  }

  return distance;
};

const getWeightedDistance = (
  left: VecFeatures,
  right: VecFeatures,
  includeZ: boolean,
) => {
  const ratioDelta = left.ratio - right.ratio;
  const sameZIntersectionsDelta =
    left.sameZIntersections - right.sameZIntersections;
  const differentZIntersectionsDelta =
    left.differentZIntersections - right.differentZIntersections;
  const entryExitZChangesDelta =
    left.entryExitZChanges - right.entryExitZChanges;

  let zDistance = 0;
  let planarDistance = 0;

  for (let pointIndex = 0; pointIndex < left.zValues.length; pointIndex += 1) {
    if (includeZ) {
      const zDelta = (left.zValues[pointIndex] ?? 0) - (right.zValues[pointIndex] ?? 0);
      zDistance += zDelta * zDelta;
    }

    const xyIndex = pointIndex * 2;
    const xDelta = (left.xyValues[xyIndex] ?? 0) - (right.xyValues[xyIndex] ?? 0);
    const yDelta =
      (left.xyValues[xyIndex + 1] ?? 0) - (right.xyValues[xyIndex + 1] ?? 0);
    planarDistance += xDelta * xDelta + yDelta * yDelta;
  }

  return Math.sqrt(
    ratioDelta * ratioDelta * VECTOR_DISTANCE_WEIGHTS.ratio +
      sameZIntersectionsDelta *
        sameZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.sameZIntersections +
      differentZIntersectionsDelta *
        differentZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.differentZIntersections +
      entryExitZChangesDelta *
        entryExitZChangesDelta *
        VECTOR_DISTANCE_WEIGHTS.entryExitZChanges +
      zDistance * VECTOR_DISTANCE_WEIGHTS.z +
      planarDistance * VECTOR_DISTANCE_WEIGHTS.distWeight,
  );
};

const getWeightedDistanceWithoutZ = (left: VecFeatures, right: VecFeatures) => {
  const ratioDelta = left.ratio - right.ratio;
  const sameZIntersectionsDelta =
    left.sameZIntersections - right.sameZIntersections;
  const differentZIntersectionsDelta =
    left.differentZIntersections - right.differentZIntersections;
  const entryExitZChangesDelta =
    left.entryExitZChanges - right.entryExitZChanges;

  let planarDistance = 0;

  for (let pointIndex = 0; pointIndex < left.zValues.length; pointIndex += 1) {
    const xyIndex = pointIndex * 2;
    const xDelta = (left.xyValues[xyIndex] ?? 0) - (right.xyValues[xyIndex] ?? 0);
    const yDelta =
      (left.xyValues[xyIndex + 1] ?? 0) - (right.xyValues[xyIndex + 1] ?? 0);
    planarDistance += xDelta * xDelta + yDelta * yDelta;
  }

  return Math.sqrt(
    ratioDelta * ratioDelta * VECTOR_DISTANCE_WEIGHTS.ratio +
      sameZIntersectionsDelta *
        sameZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.sameZIntersections +
      differentZIntersectionsDelta *
        differentZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.differentZIntersections +
      entryExitZChangesDelta *
        entryExitZChangesDelta *
        VECTOR_DISTANCE_WEIGHTS.entryExitZChanges +
      planarDistance * VECTOR_DISTANCE_WEIGHTS.distWeight,
  );
};

const isCandidateWorse = (left: RankedCandidate, right: RankedCandidate) => {
  if (left.distance !== right.distance) {
    return left.distance > right.distance;
  }

  return left.variant.ordinal > right.variant.ordinal;
};

const swapHeapItems = (
  heap: RankedCandidate[],
  leftIndex: number,
  rightIndex: number,
) => {
  [heap[leftIndex], heap[rightIndex]] = [heap[rightIndex]!, heap[leftIndex]!];
};

const siftUpMaxHeap = (heap: RankedCandidate[], index: number) => {
  let currentIndex = index;

  while (currentIndex > 0) {
    const parentIndex = Math.floor((currentIndex - 1) / 2);
    if (
      !isCandidateWorse(
        heap[currentIndex]!,
        heap[parentIndex]!,
      )
    ) {
      break;
    }

    swapHeapItems(heap, parentIndex, currentIndex);
    currentIndex = parentIndex;
  }
};

const siftDownMaxHeap = (heap: RankedCandidate[], index: number) => {
  let currentIndex = index;

  while (true) {
    const leftChildIndex = currentIndex * 2 + 1;
    const rightChildIndex = leftChildIndex + 1;
    let nextIndex = currentIndex;

    if (
      leftChildIndex < heap.length &&
      isCandidateWorse(heap[leftChildIndex]!, heap[nextIndex]!)
    ) {
      nextIndex = leftChildIndex;
    }

    if (
      rightChildIndex < heap.length &&
      isCandidateWorse(heap[rightChildIndex]!, heap[nextIndex]!)
    ) {
      nextIndex = rightChildIndex;
    }

    if (nextIndex === currentIndex) {
      return;
    }

    swapHeapItems(heap, currentIndex, nextIndex);
    currentIndex = nextIndex;
  }
};

const maybeInsertCandidate = (
  heap: RankedCandidate[],
  candidate: RankedCandidate,
  limit: number,
) => {
  if (heap.length < limit) {
    heap.push(candidate);
    siftUpMaxHeap(heap, heap.length - 1);
    return;
  }

  const worstCandidate = heap[0];
  if (!worstCandidate) {
    return;
  }

  if (!isCandidateWorse(worstCandidate, candidate)) {
    return;
  }

  heap[0] = candidate;
  siftDownMaxHeap(heap, 0);
};

const sortRankedCandidates = (candidates: RankedCandidate[]) =>
  candidates.toSorted((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance - right.distance;
    }

    return left.variant.ordinal - right.variant.ordinal;
  });

const createBenchmarkVariants = (entries: SolveCacheEntry[]) => {
  const variants: BenchmarkVariant[] = [];
  let ordinal = 0;

  entries.forEach((sourceEntry, sourceEntryIndex) => {
    SOLVE_CACHE_SYMMETRIES.forEach((symmetry) => {
      const entry = getSolveCacheEntrySymmetryVariant(sourceEntry, symmetry);
      variants.push({
        ordinal,
        sourceEntryIndex,
        symmetry,
        entry,
        features: extractVecFeatures(entry.vecRaw),
      });
      ordinal += 1;
    });
  });

  return variants;
};

const createBucketsByZSignature = (variants: BenchmarkVariant[]) => {
  const bucketsByZSignature = new Map<string, BenchmarkBucket>();

  for (const variant of variants) {
    const existingBucket = bucketsByZSignature.get(variant.features.zSignature);
    if (existingBucket) {
      existingBucket.variants.push(variant);
      continue;
    }

    bucketsByZSignature.set(variant.features.zSignature, {
      zSignature: variant.features.zSignature,
      zValues: variant.features.zValues,
      variants: [variant],
    });
  }

  return [...bucketsByZSignature.values()];
};

const rankCurrentCandidates = (
  targetFeatures: VecFeatures,
  buckets: BenchmarkBucket[],
  topK: number,
) => {
  const rankedBuckets = buckets
    .map((bucket) => ({
      bucket,
      lowerBound: Math.sqrt(
        getHammingDistance(targetFeatures.zValues, bucket.zValues) *
          VECTOR_DISTANCE_WEIGHTS.z,
      ),
    }))
    .toSorted((left, right) => left.lowerBound - right.lowerBound);

  const heap: RankedCandidate[] = [];

  for (const rankedBucket of rankedBuckets) {
    if (
      heap.length === topK &&
      (heap[0]?.distance ?? Number.POSITIVE_INFINITY) < rankedBucket.lowerBound
    ) {
      break;
    }

    for (const variant of rankedBucket.bucket.variants) {
      maybeInsertCandidate(
        heap,
        {
          variant,
          distance: getWeightedDistance(targetFeatures, variant.features, true),
        },
        topK,
      );
    }
  }

  return sortRankedCandidates(heap);
};

const rankSameZIndexedCandidates = (
  targetFeatures: VecFeatures,
  bucketsByZSignature: Map<string, BenchmarkBucket>,
  topK: number,
) => {
  const bucket = bucketsByZSignature.get(targetFeatures.zSignature);
  if (!bucket) {
    return [];
  }

  const heap: RankedCandidate[] = [];

  for (const variant of bucket.variants) {
    maybeInsertCandidate(
      heap,
      {
        variant,
        distance: getWeightedDistanceWithoutZ(targetFeatures, variant.features),
      },
      topK,
    );
  }

  return sortRankedCandidates(heap);
};

const evaluateRankedCandidates = (
  sample: ReturnType<typeof canonicalizeDatasetSample>,
  rankedCandidates: RankedCandidate[],
  applicationVerdictsByOrdinal: Map<number, boolean>,
): MatchSummary => {
  for (let candidateIndex = 0; candidateIndex < rankedCandidates.length; candidateIndex += 1) {
    const candidate = rankedCandidates[candidateIndex]!;
    const cachedVerdict = applicationVerdictsByOrdinal.get(
      candidate.variant.ordinal,
    );

    if (cachedVerdict !== undefined) {
      if (cachedVerdict) {
        return {
          hit: true,
          firstPassRank: candidateIndex + 1,
        };
      }

      continue;
    }

    const result = diagnoseSolveCacheEntryApplication(
      sample,
      candidate.variant.entry,
    );
    applicationVerdictsByOrdinal.set(candidate.variant.ordinal, result.ok);

    if (result.ok) {
      return {
        hit: true,
        firstPassRank: candidateIndex + 1,
      };
    }
  }

  return {
    hit: false,
    firstPassRank: null,
  };
};

const updateBenchmarkStats = (stats: BenchmarkStats, summary: MatchSummary) => {
  if (summary.hit) {
    stats.hits += 1;
    if (summary.firstPassRank !== null) {
      stats.firstPassRankSum += summary.firstPassRank;
      stats.firstPassRankCount += 1;
    }
    return;
  }

  stats.misses += 1;
};

const formatStats = (stats: BenchmarkStats) => {
  const total = stats.hits + stats.misses;
  const accuracy = total === 0 ? 0 : stats.hits / total;
  const avgFirstPassRank =
    stats.firstPassRankCount === 0
      ? null
      : stats.firstPassRankSum / stats.firstPassRankCount;

  return {
    total,
    hits: stats.hits,
    misses: stats.misses,
    accuracy,
    avgFirstPassRank,
  };
};

const createGeneratedSamples = (
  pairCount: number,
  sampleCount: number,
  startIndex: number,
) => {
  const random = createDeterministicRandom(
    getSampleSeed(startIndex, BENCHMARK_DATASET_SEED ^ pairCount),
  );

  return Array.from({ length: sampleCount }, () => {
    const sampleIndex = startIndex + Math.floor(random() * 9_000_000);
    return canonicalizeDatasetSample(
      createMatchSampleWithPairCount(sampleIndex, pairCount),
    );
  });
};

const verifyProductionRanker = (
  samples: ReturnType<typeof canonicalizeDatasetSample>[],
  entries: SolveCacheEntry[],
  bucketsByZSignature: Map<string, BenchmarkBucket>,
  verifyCount: number,
  topK: number,
) => {
  const samplesToVerify = samples.slice(0, verifyCount);
  let matched = 0;

  for (const sample of samplesToVerify) {
    const targetFeatures = extractVecFeatures(sample.vecRaw ?? []);
    const rankedCandidates = rankSameZIndexedCandidates(
      targetFeatures,
      bucketsByZSignature,
      topK,
    );
    const benchmarkSummary = evaluateRankedCandidates(
      sample,
      rankedCandidates,
      new Map(),
    );
    const liveSummary = findSolveCacheMatch(sample, entries, {
      maxCandidatesToTry: topK,
    }).match !== null;

    if (benchmarkSummary.hit !== liveSummary) {
      throw new Error(
        `Benchmark production ranker mismatch for ${sample.capacityMeshNodeId}: benchmark=${benchmarkSummary.hit} live=${liveSummary}`,
      );
    }

    matched += 1;
  }

  return matched;
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
  const startIndex = parseIntegerFlag(
    argv,
    ["--start-index"],
    DEFAULT_START_INDEX,
  );
  const topK = parseIntegerFlag(argv, ["--top-k"], DEFAULT_TOP_K);
  const progressEvery = parseIntegerFlag(
    argv,
    ["--progress-every"],
    DEFAULT_PROGRESS_EVERY,
  );
  const verifyCount = parseIntegerFlag(
    argv,
    ["--verify-count"],
    DEFAULT_VERIFY_COUNT,
  );

  const cachePath = join(process.cwd(), `solve-cache-${pairCount}.json`);
  const rawCache = await Bun.file(cachePath).text();
  const solveCache = parseSolveCacheFile(JSON.parse(rawCache), pairCount);

  console.log(
    `Loaded ${solveCache.entries.length} solve-cache entries from ${cachePath}`,
  );

  const variantBuildStart = performance.now();
  const variants = createBenchmarkVariants(solveCache.entries);
  const buckets = createBucketsByZSignature(variants);
  const bucketsByZSignature = new Map(
    buckets.map((bucket) => [bucket.zSignature, bucket]),
  );
  const variantBuildElapsedMs = performance.now() - variantBuildStart;

  const bucketSizes = buckets
    .map((bucket) => bucket.variants.length)
    .toSorted((left, right) => left - right);
  const medianBucketSize =
    bucketSizes[Math.floor(bucketSizes.length / 2)] ?? 0;
  const averageBucketSize =
    buckets.length === 0 ? 0 : variants.length / buckets.length;

  console.log(
    `Built ${variants.length} symmetry variants across ${buckets.length} z-signature buckets in ${(variantBuildElapsedMs / 1000).toFixed(1)}s`,
  );
  console.log(
    `z bucket sizes: min=${bucketSizes[0] ?? 0} median=${medianBucketSize} avg=${averageBucketSize.toFixed(1)} max=${bucketSizes.at(-1) ?? 0}`,
  );

  const samples = createGeneratedSamples(pairCount, sampleCount, startIndex);
  console.log(
    `Generated ${samples.length} canonicalized samples for pairCount=${pairCount}`,
  );

  const verifiedCount = verifyProductionRanker(
    samples,
    solveCache.entries,
    bucketsByZSignature,
    Math.min(verifyCount, samples.length),
    topK,
  );
  console.log(
    `Verified production same-z matcher against live matcher on ${verifiedCount} samples`,
  );

  const currentStats: BenchmarkStats = {
    hits: 0,
    misses: 0,
    firstPassRankSum: 0,
    firstPassRankCount: 0,
  };
  const zIndexedStats: BenchmarkStats = {
    hits: 0,
    misses: 0,
    firstPassRankSum: 0,
    firstPassRankCount: 0,
  };

  const benchmarkStart = performance.now();

  samples.forEach((sample, sampleIndex) => {
    const targetFeatures = extractVecFeatures(sample.vecRaw ?? []);
    const applicationVerdictsByOrdinal = new Map<number, boolean>();
    const currentSummary = evaluateRankedCandidates(
      sample,
      rankCurrentCandidates(targetFeatures, buckets, topK),
      applicationVerdictsByOrdinal,
    );
    const zIndexedSummary = evaluateRankedCandidates(
      sample,
      rankSameZIndexedCandidates(targetFeatures, bucketsByZSignature, topK),
      applicationVerdictsByOrdinal,
    );

    updateBenchmarkStats(currentStats, currentSummary);
    updateBenchmarkStats(zIndexedStats, zIndexedSummary);

    const processedCount = sampleIndex + 1;
    if (
      processedCount % progressEvery === 0 ||
      processedCount === samples.length
    ) {
      const elapsedSeconds = (performance.now() - benchmarkStart) / 1000;
      const current = formatStats(currentStats);
      const zIndexed = formatStats(zIndexedStats);

      console.log(
        [
          `progress=${processedCount}/${samples.length}`,
          `elapsed=${elapsedSeconds.toFixed(1)}s`,
          `currentAccuracy=${current.accuracy.toFixed(4)}`,
          `currentAvgFirstPassRank=${current.avgFirstPassRank?.toFixed(2) ?? "n/a"}`,
          `sameZNoZAccuracy=${zIndexed.accuracy.toFixed(4)}`,
          `sameZNoZAvgFirstPassRank=${zIndexed.avgFirstPassRank?.toFixed(2) ?? "n/a"}`,
        ].join(" "),
      );
    }
  });

  const elapsedSeconds = (performance.now() - benchmarkStart) / 1000;
  const current = formatStats(currentStats);
  const zIndexed = formatStats(zIndexedStats);

  console.log("");
  console.log("Current Matcher");
  console.log(
    [
      `samples=${current.total}`,
      `hits=${current.hits}`,
      `misses=${current.misses}`,
      `accuracy=${current.accuracy.toFixed(4)}`,
      `avgFirstPassRank=${current.avgFirstPassRank?.toFixed(2) ?? "n/a"}`,
    ].join(" "),
  );
  console.log("Same-Z Indexed, No Z Similarity");
  console.log(
    [
      `samples=${zIndexed.total}`,
      `hits=${zIndexed.hits}`,
      `misses=${zIndexed.misses}`,
      `accuracy=${zIndexed.accuracy.toFixed(4)}`,
      `avgFirstPassRank=${zIndexed.avgFirstPassRank?.toFixed(2) ?? "n/a"}`,
    ].join(" "),
  );
  console.log("Delta");
  console.log(
    [
      `accuracy=${(zIndexed.accuracy - current.accuracy).toFixed(4)}`,
      `avgFirstPassRank=${
        current.avgFirstPassRank === null || zIndexed.avgFirstPassRank === null
          ? "n/a"
          : (zIndexed.avgFirstPassRank - current.avgFirstPassRank).toFixed(2)
      }`,
      `elapsed=${elapsedSeconds.toFixed(1)}s`,
    ].join(" "),
  );
};

await main();
