import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import type { DrcCheckResult } from "../../lib/drc-check";
import {
  SOLVE_CACHE_SYMMETRIES,
  type NodeCanonicalizationResult,
  type SolveCacheApplyFailure,
  type SolveCacheEntry,
  canonicalizeNodeWithPortPoints,
  createValidatedSolveCacheEntry,
  decanonicalizeSolution,
  diagnoseSolveCacheEntryApplication,
  getNodeCanonicalizationResult,
  getNodePointPairCount,
  getSolveCacheEntrySymmetryVariant,
} from "../../lib/solve-cache";
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../../lib/types";
import { computeVecRaw } from "../../lib/vec-raw";
import {
  getVectorDistanceIgnoringZ,
  getVectorZSignature,
} from "../../lib/vector-search";
import type {
  KvNamespaceLike,
  WorkerBucket,
  WorkerBucketEntry,
} from "./contracts";

const DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY = 16;
const DEFAULT_SOLVER_MAX_ITERATIONS = 250_000;
const DEFAULT_TRACE_WIDTH = 0.1;
const DEFAULT_VIA_DIAMETER = 0.3;
const BUCKET_SCHEMA_VERSION = 1;
const WORKER_BUCKET_MEMORY_CACHE_TTL_MS = 5 * 60 * 1_000;

const workerBucketMemoryCache = new Map<
  string,
  {
    bucket: WorkerBucket;
    cachedAt: number;
  }
>();

type CanonicalizedRequest = {
  canonicalNodeWithPortPoints: NodeWithPortPoints;
  canonicalization: NodeCanonicalizationResult;
  pairCount: number;
  vecRaw: number[];
  zSignature: string;
  bucketKey: string;
};

type RankedCandidate = {
  entry: WorkerBucketEntry;
  distance: number;
};

type BucketMatchResult = {
  routes: HighDensityIntraNodeRoute[];
  drc: DrcCheckResult;
  nearestFailure: SolveCacheApplyFailure | null;
  candidateDistance: number;
} | null;

type SolveWorkerConfig = {
  maxCandidatesToTry: number;
  solverMaxIterations: number;
  traceWidth: number;
  viaDiameter: number;
};

const toDatasetSample = (nodeWithPortPoints: NodeWithPortPoints) => ({
  ...nodeWithPortPoints,
  solvable: false,
  solution: null,
});

const parsePositiveInteger = (rawValue: string | undefined, defaultValue: number) => {
  if (rawValue === undefined) return defaultValue;

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
};

const parsePositiveNumber = (rawValue: string | undefined, defaultValue: number) => {
  if (rawValue === undefined) return defaultValue;

  const parsedValue = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
};

export const getSolveWorkerConfig = (env: {
  MAX_SOLVE_CACHE_CANDIDATES_TO_TRY?: string;
  SOLVER_MAX_ITERATIONS?: string;
  TRACE_WIDTH?: string;
  VIA_DIAMETER?: string;
}): SolveWorkerConfig => ({
  maxCandidatesToTry: parsePositiveInteger(
    env.MAX_SOLVE_CACHE_CANDIDATES_TO_TRY,
    DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY,
  ),
  solverMaxIterations: parsePositiveInteger(
    env.SOLVER_MAX_ITERATIONS,
    DEFAULT_SOLVER_MAX_ITERATIONS,
  ),
  traceWidth: parsePositiveNumber(env.TRACE_WIDTH, DEFAULT_TRACE_WIDTH),
  viaDiameter: parsePositiveNumber(env.VIA_DIAMETER, DEFAULT_VIA_DIAMETER),
});

const hashString = (value: string) => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

const getWorkerBucketEntryId = (entry: SolveCacheEntry) =>
  hashString(JSON.stringify({ sample: entry.sample, solution: entry.solution }));

export const getBucketKey = (pointPairCount: number, zSignature: string) =>
  `${pointPairCount}:${zSignature}`;

export const getWorkerBucketFromMemoryCache = (bucketKey: string) => {
  const cachedEntry = workerBucketMemoryCache.get(bucketKey);
  if (!cachedEntry) {
    return null;
  }

  if (Date.now() - cachedEntry.cachedAt > WORKER_BUCKET_MEMORY_CACHE_TTL_MS) {
    workerBucketMemoryCache.delete(bucketKey);
    return null;
  }

  return cachedEntry.bucket;
};

export const setWorkerBucketInMemoryCache = (
  bucketKey: string,
  bucket: WorkerBucket,
) => {
  workerBucketMemoryCache.set(bucketKey, {
    bucket,
    cachedAt: Date.now(),
  });
};

export const canonicalizeSolveRequest = (
  nodeWithPortPoints: NodeWithPortPoints,
): CanonicalizedRequest => {
  const canonicalization = getNodeCanonicalizationResult(nodeWithPortPoints);
  const canonicalNodeWithPortPoints =
    canonicalizeNodeWithPortPoints(nodeWithPortPoints);
  const pairCount = getNodePointPairCount(canonicalNodeWithPortPoints);
  const vecRaw = computeVecRaw(toDatasetSample(canonicalNodeWithPortPoints));
  const zSignature = getVectorZSignature(vecRaw);

  return {
    canonicalNodeWithPortPoints,
    canonicalization,
    pairCount,
    vecRaw,
    zSignature,
    bucketKey: getBucketKey(pairCount, zSignature),
  };
};

const createEmptyBucket = (
  pointPairCount: number,
  zSignature: string,
): WorkerBucket => ({
  version: BUCKET_SCHEMA_VERSION,
  pointPairCount,
  zSignature,
  entries: [],
  updatedAt: new Date().toISOString(),
});

export const createEmptyWorkerBucket = createEmptyBucket;

const normalizeBucketEntry = (entry: WorkerBucketEntry): WorkerBucketEntry => ({
  ...entry,
  zSignature:
    typeof entry.zSignature === "string" && entry.zSignature.length > 0
      ? entry.zSignature
      : getVectorZSignature(entry.vecRaw),
});

export const parseWorkerBucket = (
  rawBucket: string | null,
  pointPairCount: number,
  zSignature: string,
): WorkerBucket => {
  if (!rawBucket) {
    return createEmptyBucket(pointPairCount, zSignature);
  }

  const parsedBucket = JSON.parse(rawBucket) as Partial<WorkerBucket>;
  const entries = (parsedBucket.entries ?? []).map(normalizeBucketEntry);

  return {
    version: BUCKET_SCHEMA_VERSION,
    pointPairCount,
    zSignature,
    entries,
    updatedAt:
      typeof parsedBucket.updatedAt === "string"
        ? parsedBucket.updatedAt
        : new Date().toISOString(),
  };
};

export const loadWorkerBucket = async (
  kv: KvNamespaceLike,
  pointPairCount: number,
  zSignature: string,
) => {
  const bucketKey = getBucketKey(pointPairCount, zSignature);
  const cachedBucket = getWorkerBucketFromMemoryCache(bucketKey);
  if (cachedBucket) {
    return cachedBucket;
  }

  const bucket = parseWorkerBucket(
    await kv.get(bucketKey, "text"),
    pointPairCount,
    zSignature,
  );
  setWorkerBucketInMemoryCache(bucketKey, bucket);
  return bucket;
};

export const getWorkerBucketRawText = (
  kv: KvNamespaceLike,
  pointPairCount: number,
  zSignature: string,
) => kv.get(getBucketKey(pointPairCount, zSignature), "text");

const serializeWorkerBucket = (bucket: WorkerBucket) =>
  JSON.stringify({
    ...bucket,
    updatedAt: new Date().toISOString(),
  });

const mergeBucketEntries = (
  bucket: WorkerBucket,
  nextEntries: WorkerBucketEntry[],
): WorkerBucket => {
  const entriesById = new Map<string, WorkerBucketEntry>();

  for (const entry of bucket.entries) {
    entriesById.set(entry.entryId, entry);
  }

  for (const entry of nextEntries) {
    entriesById.set(entry.entryId, entry);
  }

  return {
    ...bucket,
    entries: [...entriesById.values()],
    updatedAt: new Date().toISOString(),
  };
};

export const mergeWorkerBucketEntries = mergeBucketEntries;

export const saveWorkerBucket = async (
  kv: KvNamespaceLike,
  bucket: WorkerBucket,
) => {
  const bucketKey = getBucketKey(bucket.pointPairCount, bucket.zSignature);
  await kv.put(
    bucketKey,
    serializeWorkerBucket(bucket),
  );
  setWorkerBucketInMemoryCache(bucketKey, bucket);
};

const insertTopCandidate = (
  candidates: RankedCandidate[],
  candidate: RankedCandidate,
  maxCandidatesToTry: number,
) => {
  if (maxCandidatesToTry <= 0) {
    return;
  }

  if (
    candidates.length === maxCandidatesToTry &&
    candidate.distance >= candidates[candidates.length - 1]!.distance
  ) {
    return;
  }

  let insertIndex = candidates.findIndex(
    (existingCandidate) => candidate.distance < existingCandidate.distance,
  );
  if (insertIndex === -1) {
    insertIndex = candidates.length;
  }

  candidates.splice(insertIndex, 0, candidate);

  if (candidates.length > maxCandidatesToTry) {
    candidates.length = maxCandidatesToTry;
  }
};

export const selectBucketCandidates = (
  targetVecRaw: number[],
  entries: WorkerBucketEntry[],
  maxCandidatesToTry: number,
) => {
  const topCandidates: RankedCandidate[] = [];

  for (const entry of entries) {
    if (entry.vecRaw.length !== targetVecRaw.length) {
      continue;
    }

    insertTopCandidate(
      topCandidates,
      {
        entry,
        distance: getVectorDistanceIgnoringZ(targetVecRaw, entry.vecRaw),
      },
      maxCandidatesToTry,
    );
  }

  return topCandidates;
};

export const findBucketMatch = (
  targetNodeWithPortPoints: NodeWithPortPoints,
  targetVecRaw: number[],
  bucketEntries: WorkerBucketEntry[],
  maxCandidatesToTry: number,
): BucketMatchResult => {
  const candidates = selectBucketCandidates(
    targetVecRaw,
    bucketEntries,
    maxCandidatesToTry,
  );
  let nearestFailure: SolveCacheApplyFailure | null = null;

  for (const candidate of candidates) {
    const result = diagnoseSolveCacheEntryApplication(
      targetNodeWithPortPoints,
      candidate.entry,
    );

    if (result.ok) {
      return {
        routes: result.routes,
        drc: result.drc,
        nearestFailure,
        candidateDistance: candidate.distance,
      };
    }

    if (nearestFailure === null) {
      nearestFailure = result;
    }
  }

  return null;
};

export const solveNodeWithAutorouter = (
  nodeWithPortPoints: NodeWithPortPoints,
  config: SolveWorkerConfig,
) => {
  const solver = new HyperSingleIntraNodeSolver({
    nodeWithPortPoints,
    effort: 1,
    traceWidth: config.traceWidth,
    viaDiameter: config.viaDiameter,
  });

  solver.MAX_ITERATIONS = config.solverMaxIterations;
  solver.solve();

  return solver.solved
    ? (solver.solvedRoutes as HighDensityIntraNodeRoute[])
    : null;
};

export const decanonicalizeRoutesForResponse = (
  routes: HighDensityIntraNodeRoute[] | null,
  canonicalization: NodeCanonicalizationResult,
) => decanonicalizeSolution(routes, canonicalization);

export const expandEntryIntoWorkerBuckets = (
  entry: SolveCacheEntry,
): WorkerBucketEntry[] => {
  const seenEntryIds = new Set<string>();
  const bucketEntries: WorkerBucketEntry[] = [];

  for (const symmetry of SOLVE_CACHE_SYMMETRIES) {
    const variantEntry = getSolveCacheEntrySymmetryVariant(entry, symmetry);
    const entryId = getWorkerBucketEntryId(variantEntry);

    if (seenEntryIds.has(entryId)) {
      continue;
    }

    seenEntryIds.add(entryId);
    bucketEntries.push({
      ...variantEntry,
      entryId,
      symmetry,
      zSignature: getVectorZSignature(variantEntry.vecRaw),
      sourceCapacityMeshNodeId: entry.sample.capacityMeshNodeId,
    });
  }

  return bucketEntries;
};

export const groupBucketEntriesByKey = (entries: WorkerBucketEntry[]) => {
  const entriesByBucketKey = new Map<string, WorkerBucketEntry[]>();

  for (const entry of entries) {
    const bucketKey = getBucketKey(
      getNodePointPairCount(entry.sample),
      entry.zSignature,
    );
    const existingEntries = entriesByBucketKey.get(bucketKey) ?? [];
    existingEntries.push(entry);
    entriesByBucketKey.set(bucketKey, existingEntries);
  }

  return entriesByBucketKey;
};

export const upsertValidatedEntryAcrossBuckets = async (
  kv: KvNamespaceLike,
  entry: SolveCacheEntry,
) => {
  const expandedEntries = expandEntryIntoWorkerBuckets(entry);
  const entriesByBucketKey = groupBucketEntriesByKey(expandedEntries);

  for (const [bucketKey, bucketEntries] of entriesByBucketKey.entries()) {
    const [rawPointPairCount, zSignature] = bucketKey.split(":");
    const pointPairCount = Number.parseInt(rawPointPairCount ?? "", 10);
    const existingBucket = await loadWorkerBucket(kv, pointPairCount, zSignature ?? "");
    const mergedBucket = mergeBucketEntries(existingBucket, bucketEntries);
    await saveWorkerBucket(kv, mergedBucket);
  }
};

export const mergeEntriesIntoBucket = async (
  kv: KvNamespaceLike,
  pointPairCount: number,
  zSignature: string,
  entries: WorkerBucketEntry[],
) => {
  const existingBucket = await loadWorkerBucket(kv, pointPairCount, zSignature);
  const mergedBucket = mergeBucketEntries(existingBucket, entries);
  await saveWorkerBucket(kv, mergedBucket);
  return mergedBucket;
};

export const validateSolvedEntry = (
  nodeWithPortPoints: NodeWithPortPoints,
  routes: HighDensityIntraNodeRoute[],
) => createValidatedSolveCacheEntry(nodeWithPortPoints, routes);
