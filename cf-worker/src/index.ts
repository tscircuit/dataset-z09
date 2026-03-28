import {
  canonicalizeSolveRequest,
  createEmptyWorkerBucket,
  decanonicalizeRoutesForResponse,
  expandEntryIntoWorkerBuckets,
  findBucketMatch,
  getWorkerBucketFromMemoryCache,
  getBucketKey,
  getSolveWorkerConfig,
  getWorkerBucketRawText,
  mergeEntriesIntoBucket,
  mergeWorkerBucketEntries,
  parseWorkerBucket,
  setWorkerBucketInMemoryCache,
  solveNodeWithAutorouter,
  upsertValidatedEntryAcrossBuckets,
  validateSolvedEntry,
} from "./cache-logic";
import type {
  SolveBatchRequestBody,
  SolveBatchResponseBody,
  SolveResponseBody,
  SolveTimingBreakdown,
  UpsertBucketRequestBody,
  WorkerEnv,
  WorkerExecutionContext,
} from "./contracts";

const MAX_BATCH_SIZE = 64;

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
    ...init,
  });

const errorResponse = (status: number, message: string) =>
  jsonResponse(
    {
      ok: false,
      message,
    },
    { status },
  );

const getRequestBearerToken = (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length);
};

const requireAdminToken = (request: Request, env: WorkerEnv) => {
  const configuredToken = env.ADMIN_TOKEN?.trim();
  if (!configuredToken) {
    return errorResponse(403, "ADMIN_TOKEN is not configured for this worker.");
  }

  return getRequestBearerToken(request) === configuredToken
    ? null
    : errorResponse(401, "Invalid admin token.");
};

const handleHealthRequest = () =>
  jsonResponse({
    ok: true,
    service: "dataset-z09-solve-cache",
  });

const createCacheLookupTimings = (
  kvGetMs: number,
  bucketParseMs: number,
  rankingMs: number,
  totalMs: number,
): SolveTimingBreakdown => ({
  total: totalMs,
  kvRead: kvGetMs + bucketParseMs,
  kvGet: kvGetMs,
  bucketParse: bucketParseMs,
  ranking: rankingMs,
  cacheApply: rankingMs,
});

const toCompactSolveBatchResult = (responseBody: SolveResponseBody) => ({
  source: responseBody.source,
  routes: responseBody.routes,
  ...(responseBody.message ? { message: responseBody.message } : {}),
});

const solveAgainstLoadedBucket = async ({
  solveRequest,
  bucket,
  env,
  config,
  baseTimingsMs,
}: {
  solveRequest: ReturnType<typeof canonicalizeSolveRequest>;
  bucket: ReturnType<typeof parseWorkerBucket>;
  env: WorkerEnv;
  config: ReturnType<typeof getSolveWorkerConfig>;
  baseTimingsMs?: Partial<SolveTimingBreakdown>;
}): Promise<{
  responseBody: SolveResponseBody;
  expandedEntries: ReturnType<typeof expandEntryIntoWorkerBuckets> | null;
}> => {
  const requestStart = performance.now();
  const rankingStart = performance.now();
  const match = findBucketMatch(
    solveRequest.canonicalNodeWithPortPoints,
    solveRequest.vecRaw,
    bucket.entries,
    config.maxCandidatesToTry,
  );
  const rankingEnd = performance.now();
  const rankingMs = rankingEnd - rankingStart;

  if (match) {
    return {
      responseBody: {
        ok: true,
        source: "cache",
        pairCount: solveRequest.pairCount,
        zSignature: solveRequest.zSignature,
        bucketKey: solveRequest.bucketKey,
        bucketSize: bucket.entries.length,
        routes: decanonicalizeRoutesForResponse(
          match.routes,
          solveRequest.canonicalization,
        ),
        drc: match.drc,
        timingsMs: {
          ...baseTimingsMs,
          ranking: rankingMs,
          cacheApply: rankingMs,
          total: performance.now() - requestStart,
        },
      },
      expandedEntries: null,
    };
  }

  const solveStart = performance.now();
  const solvedRoutes = solveNodeWithAutorouter(
    solveRequest.canonicalNodeWithPortPoints,
    config,
  );
  const solveEnd = performance.now();
  const solveMs = solveEnd - solveStart;

  if (!solvedRoutes) {
    return {
      responseBody: {
        ok: true,
        source: "none",
        pairCount: solveRequest.pairCount,
        zSignature: solveRequest.zSignature,
        bucketKey: solveRequest.bucketKey,
        bucketSize: bucket.entries.length,
        routes: null,
        drc: null,
        solverSolved: false,
        message: "Solver did not find a solution.",
        timingsMs: {
          ...baseTimingsMs,
          ranking: rankingMs,
          solve: solveMs,
          total: performance.now() - requestStart,
        },
      },
      expandedEntries: null,
    };
  }

  const validatedEntry = validateSolvedEntry(
    solveRequest.canonicalNodeWithPortPoints,
    solvedRoutes,
  );

  if (!validatedEntry) {
    return {
      responseBody: {
        ok: true,
        source: "none",
        pairCount: solveRequest.pairCount,
        zSignature: solveRequest.zSignature,
        bucketKey: solveRequest.bucketKey,
        bucketSize: bucket.entries.length,
        routes: null,
        drc: null,
        solverSolved: true,
        message: "Solver produced routes, but they failed validation.",
        timingsMs: {
          ...baseTimingsMs,
          ranking: rankingMs,
          solve: solveMs,
          total: performance.now() - requestStart,
        },
      },
      expandedEntries: null,
    };
  }

  const kvWriteStart = performance.now();
  await upsertValidatedEntryAcrossBuckets(env.SOLVE_CACHE, validatedEntry);
  const kvWriteEnd = performance.now();
  const kvWriteMs = kvWriteEnd - kvWriteStart;

  return {
    responseBody: {
      ok: true,
      source: "solver",
      pairCount: solveRequest.pairCount,
      zSignature: solveRequest.zSignature,
      bucketKey: solveRequest.bucketKey,
      bucketSize: bucket.entries.length + 1,
      routes: decanonicalizeRoutesForResponse(
        validatedEntry.solution,
        solveRequest.canonicalization,
      ),
      drc: null,
      solverSolved: true,
      timingsMs: {
        ...baseTimingsMs,
        ranking: rankingMs,
        solve: solveMs,
        kvWrite: kvWriteMs,
        total: performance.now() - requestStart,
      },
    },
    expandedEntries: expandEntryIntoWorkerBuckets(validatedEntry),
  };
};

const handleSolveRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveBatchRequestBody> & {
    nodeWithPortPoints?: unknown;
  };
  const rawNodeWithPortPoints = requestBody.nodeWithPortPoints;

  if (!rawNodeWithPortPoints || typeof rawNodeWithPortPoints !== "object") {
    return errorResponse(400, "Request body must include nodeWithPortPoints.");
  }

  const config = getSolveWorkerConfig(env);
  const solveRequest = canonicalizeSolveRequest(rawNodeWithPortPoints as never);

  const cachedBucket = getWorkerBucketFromMemoryCache(solveRequest.bucketKey);
  let kvGetMs = 0;
  let bucketParseMs = 0;
  let bucket = cachedBucket;

  if (!bucket) {
    const kvGetStart = performance.now();
    const rawBucket = await getWorkerBucketRawText(
      env.SOLVE_CACHE,
      solveRequest.pairCount,
      solveRequest.zSignature,
    );
    const kvGetEnd = performance.now();
    const bucketParseStart = performance.now();
    bucket = parseWorkerBucket(
      rawBucket,
      solveRequest.pairCount,
      solveRequest.zSignature,
    );
    const bucketParseEnd = performance.now();
    kvGetMs = kvGetEnd - kvGetStart;
    bucketParseMs = bucketParseEnd - bucketParseStart;
    setWorkerBucketInMemoryCache(solveRequest.bucketKey, bucket);
  }

  const result = await solveAgainstLoadedBucket({
    solveRequest,
    bucket: bucket ?? createEmptyWorkerBucket(solveRequest.pairCount, solveRequest.zSignature),
    env,
    config,
    baseTimingsMs: createCacheLookupTimings(
      kvGetMs,
      bucketParseMs,
      0,
      performance.now() - totalStart,
    ),
  });

  result.responseBody.timingsMs.total = performance.now() - totalStart;

  return jsonResponse(result.responseBody);
};

const handleSolveBatchRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveBatchRequestBody>;

  if (!Array.isArray(requestBody.nodesWithPortPoints)) {
    return errorResponse(400, "Request body must include nodesWithPortPoints.");
  }

  if (requestBody.nodesWithPortPoints.length === 0) {
    return errorResponse(400, "nodesWithPortPoints must not be empty.");
  }

  if (requestBody.nodesWithPortPoints.length > MAX_BATCH_SIZE) {
    return errorResponse(
      400,
      `nodesWithPortPoints may contain at most ${MAX_BATCH_SIZE} nodes.`,
    );
  }

  const config = getSolveWorkerConfig(env);
  const responseMode = requestBody.responseMode ?? "compact";

  const canonicalizeStart = performance.now();
  const solveRequests = requestBody.nodesWithPortPoints.map((nodeWithPortPoints) =>
    canonicalizeSolveRequest(nodeWithPortPoints),
  );
  const canonicalizeEnd = performance.now();

  const uniqueBuckets = new Map<
    string,
    { pointPairCount: number; zSignature: string }
  >();

  for (const solveRequest of solveRequests) {
    uniqueBuckets.set(solveRequest.bucketKey, {
      pointPairCount: solveRequest.pairCount,
      zSignature: solveRequest.zSignature,
    });
  }

  const bucketMap = new Map<
    string,
    ReturnType<typeof parseWorkerBucket>
  >();
  const missingBuckets = new Map<
    string,
    { pointPairCount: number; zSignature: string }
  >();

  for (const [bucketKey, bucketMetadata] of uniqueBuckets.entries()) {
    const cachedBucket = getWorkerBucketFromMemoryCache(bucketKey);
    if (cachedBucket) {
      bucketMap.set(bucketKey, cachedBucket);
      continue;
    }

    missingBuckets.set(bucketKey, bucketMetadata);
  }

  const kvGetStart = performance.now();
  const rawBucketEntries = await Promise.all(
    [...missingBuckets.entries()].map(async ([bucketKey, bucketMetadata]) => [
      bucketKey,
      await getWorkerBucketRawText(
        env.SOLVE_CACHE,
        bucketMetadata.pointPairCount,
        bucketMetadata.zSignature,
      ),
    ]),
  );
  const kvGetEnd = performance.now();

  const bucketParseStart = performance.now();
  for (const entry of rawBucketEntries) {
    const bucketKey = entry[0] as string;
    const rawBucket = entry[1] as string | null;
    const bucketMetadata = missingBuckets.get(bucketKey);
    if (!bucketMetadata) {
      continue;
    }

    const bucket = parseWorkerBucket(
      rawBucket,
      bucketMetadata.pointPairCount,
      bucketMetadata.zSignature,
    );
    bucketMap.set(bucketKey, bucket);
    setWorkerBucketInMemoryCache(bucketKey, bucket);
  }
  const bucketParseEnd = performance.now();

  const results: SolveResponseBody[] = [];
  let cacheCount = 0;
  let solverCount = 0;
  let noneCount = 0;
  let rankingMs = 0;
  let solveMs = 0;
  let kvWriteMs = 0;

  for (const solveRequest of solveRequests) {
    const bucket =
      bucketMap.get(solveRequest.bucketKey) ??
      createEmptyWorkerBucket(solveRequest.pairCount, solveRequest.zSignature);
    const result = await solveAgainstLoadedBucket({
      solveRequest,
      bucket,
      env,
      config,
    });

    results.push(result.responseBody);
    rankingMs += result.responseBody.timingsMs.ranking ?? 0;
    solveMs += result.responseBody.timingsMs.solve ?? 0;
    kvWriteMs += result.responseBody.timingsMs.kvWrite ?? 0;

    if (result.responseBody.source === "cache") {
      cacheCount += 1;
    } else if (result.responseBody.source === "solver") {
      solverCount += 1;
    } else {
      noneCount += 1;
    }

    if (result.expandedEntries) {
      const bucketsByKey = new Map<string, typeof result.expandedEntries>();

      for (const entry of result.expandedEntries) {
        const bucketKey = getBucketKey(result.responseBody.pairCount, entry.zSignature);
        const existingEntries = bucketsByKey.get(bucketKey) ?? [];
        existingEntries.push(entry);
        bucketsByKey.set(bucketKey, existingEntries);
      }

      for (const [bucketKey, nextEntries] of bucketsByKey.entries()) {
        const [rawPointPairCount, zSignature] = bucketKey.split(":");
        const pointPairCount = Number.parseInt(rawPointPairCount ?? "", 10);
        const currentBucket =
          bucketMap.get(bucketKey) ??
          createEmptyWorkerBucket(pointPairCount, zSignature ?? "");
        bucketMap.set(
          bucketKey,
          mergeWorkerBucketEntries(currentBucket, nextEntries),
        );
        setWorkerBucketInMemoryCache(
          bucketKey,
          bucketMap.get(bucketKey) ?? currentBucket,
        );
      }
    }
  }

  const responseBody: SolveBatchResponseBody = {
    ok: true,
    count: results.length,
    uniqueBucketCount: uniqueBuckets.size,
    results:
      responseMode === "full"
        ? results
        : results.map((result) => toCompactSolveBatchResult(result)),
    summary: {
      cache: cacheCount,
      solver: solverCount,
      none: noneCount,
    },
    timingsMs: {
      total: performance.now() - totalStart,
      canonicalize: canonicalizeEnd - canonicalizeStart,
      kvGet: kvGetEnd - kvGetStart,
      bucketParse: bucketParseEnd - bucketParseStart,
      ranking: rankingMs,
      solve: solveMs,
      kvWrite: kvWriteMs,
    },
  };

  return jsonResponse(responseBody);
};

const handleUpsertBucketRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  const authError = requireAdminToken(request, env);
  if (authError) {
    return authError;
  }

  const requestBody = (await request.json()) as UpsertBucketRequestBody;
  if (
    !Number.isInteger(requestBody.pointPairCount) ||
    requestBody.pointPairCount <= 0
  ) {
    return errorResponse(400, "pointPairCount must be a positive integer.");
  }

  if (typeof requestBody.zSignature !== "string" || requestBody.zSignature.length === 0) {
    return errorResponse(400, "zSignature must be a non-empty string.");
  }

  if (!Array.isArray(requestBody.entries)) {
    return errorResponse(400, "entries must be an array.");
  }

  const mergedBucket = await mergeEntriesIntoBucket(
    env.SOLVE_CACHE,
    requestBody.pointPairCount,
    requestBody.zSignature,
    requestBody.entries,
  );

  return jsonResponse({
    ok: true,
    pointPairCount: mergedBucket.pointPairCount,
    zSignature: mergedBucket.zSignature,
    bucketSize: mergedBucket.entries.length,
  });
};

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: WorkerExecutionContext,
  ) {
    const requestUrl = new URL(request.url);

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return handleHealthRequest();
    }

    if (request.method === "POST" && requestUrl.pathname === "/solve") {
      return handleSolveRequest(request, env);
    }

    if (request.method === "POST" && requestUrl.pathname === "/solve-batch") {
      return handleSolveBatchRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/admin/upsert-bucket"
    ) {
      return handleUpsertBucketRequest(request, env);
    }

    return errorResponse(404, "Not found.");
  },
};
