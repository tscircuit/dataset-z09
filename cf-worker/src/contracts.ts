import type { DrcCheckResult } from "../../lib/drc-check";
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../../lib/types";
import type { SolveCacheEntry, SolveCacheSymmetry } from "../../lib/solve-cache";

export type KvNamespaceLike = {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
};

export type WorkerEnv = {
  SOLVE_CACHE: KvNamespaceLike;
  ADMIN_TOKEN?: string;
  MAX_SOLVE_CACHE_CANDIDATES_TO_TRY?: string;
  SOLVER_MAX_ITERATIONS?: string;
  TRACE_WIDTH?: string;
  VIA_DIAMETER?: string;
};

export type WorkerExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type WorkerBucketEntry = SolveCacheEntry & {
  entryId: string;
  symmetry: SolveCacheSymmetry;
  zSignature: string;
  sourceCapacityMeshNodeId: string;
};

export type WorkerBucket = {
  version: 1;
  pointPairCount: number;
  zSignature: string;
  entries: WorkerBucketEntry[];
  updatedAt: string;
};

export type SolveRequestBody = {
  nodeWithPortPoints: NodeWithPortPoints;
};

export type SolveBatchRequestBody = {
  nodesWithPortPoints: NodeWithPortPoints[];
  responseMode?: "compact" | "full";
};

export type UpsertBucketRequestBody = {
  pointPairCount: number;
  zSignature: string;
  entries: WorkerBucketEntry[];
};

export type SolveTimingBreakdown = {
  total: number;
  requestDecode?: number;
  kvRead?: number;
  kvGet?: number;
  bucketParse?: number;
  ranking?: number;
  cacheApply?: number;
  solve?: number;
  kvWrite?: number;
};

export type SolveResponseBody = {
  ok: boolean;
  source: "cache" | "solver" | "none";
  pairCount: number;
  zSignature: string;
  bucketKey: string;
  bucketSize: number;
  routes: HighDensityIntraNodeRoute[] | null;
  drc: DrcCheckResult | null;
  timingsMs: SolveTimingBreakdown;
  solverSolved?: boolean;
  message?: string;
};

export type SolveBatchResponseBody = {
  ok: boolean;
  count: number;
  uniqueBucketCount: number;
  results:
    | SolveResponseBody[]
    | Array<{
        source: "cache" | "solver" | "none";
        routes: HighDensityIntraNodeRoute[] | null;
        message?: string;
      }>;
  summary: {
    cache: number;
    solver: number;
    none: number;
  };
  timingsMs: {
    total: number;
    requestDecode: number;
    canonicalize: number;
    kvGet: number;
    bucketParse: number;
    ranking: number;
    solve: number;
    kvWrite: number;
  };
};
