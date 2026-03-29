import {
  canonicalizeSolveRequest,
  decanonicalizeRoutesForResponse,
  expandEntryIntoWorkerBuckets,
  findBucketMatch,
  getVectorizeBindingForPairCount,
  getVectorizeValuesForVecRaw,
  getSolveWorkerConfig,
  loadWorkerEntriesByIds,
  saveWorkerEntries,
  solveNodeWithAutorouter,
  upsertEntriesIntoVectorize,
  validateSolvedEntry,
} from "./cache-logic";
import {
  decodeBinarySolveBatchRequest,
  encodeBinarySolveBatchResponse,
} from "./binary";
import type {
  SolveBatchRequestBody,
  SolveBatchResponseBody,
  SolveResponseBody,
  UpsertVectorizeEntriesRequestBody,
  WorkerEnv,
  WorkerExecutionContext,
} from "./contracts";
import type { NodeWithPortPoints } from "../../lib/types";

const MAX_BATCH_SIZE = 64;
const KV_PING_KEY = "__kv_ping__";

type CanonicalSolveRequest = ReturnType<typeof canonicalizeSolveRequest>;

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  Response.json(body, {
    headers: {
      "cache-control": "no-store",
    },
    ...init,
  });

const toArrayBuffer = (body: Uint8Array | ArrayBuffer) =>
  body instanceof Uint8Array
    ? body.slice().buffer
    : body.slice(0);

const binaryResponse = (
  request: Request,
  body: ArrayBuffer | Uint8Array,
  init?: ResponseInit,
) => {
  const responseHeaders = new Headers(init?.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/octet-stream");
  responseHeaders.set("vary", "accept-encoding");

  const acceptsEncoding = request.headers.get("accept-encoding") ?? "";
  const shouldGzip = acceptsEncoding.includes("gzip");
  const responseBody = toArrayBuffer(body);

  if (shouldGzip) {
    responseHeaders.set("content-encoding", "gzip");
    const responseStream = new Response(responseBody).body;

    if (responseStream) {
      return new Response(responseStream.pipeThrough(new CompressionStream("gzip")), {
        ...init,
        headers: responseHeaders,
      });
    }
  }

  return new Response(responseBody, {
    ...init,
    headers: responseHeaders,
  });
};

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

const handleDebugKvReadRequest = async (env: WorkerEnv) => {
  const value = await env.SOLVE_CACHE.get(KV_PING_KEY, "text");

  return jsonResponse({
    ok: true,
    key: KV_PING_KEY,
    hasValue: value !== null,
    valueLength: value?.length ?? 0,
  });
};

const handleDebugEchoBinaryRequest = async (request: Request) => {
  const payload = await request.arrayBuffer();

  return jsonResponse({
    ok: true,
    byteLength: payload.byteLength,
  });
};

const handleDebugEchoJsonRequest = async (request: Request) => {
  const payload = (await request.json()) as { nodesWithPortPoints?: unknown[] };

  return jsonResponse({
    ok: true,
    count: Array.isArray(payload.nodesWithPortPoints)
      ? payload.nodesWithPortPoints.length
      : 0,
  });
};

const toCompactSolveBatchResult = (responseBody: SolveResponseBody) => ({
  source: responseBody.source,
  routes: responseBody.routes,
  ...(responseBody.message ? { message: responseBody.message } : {}),
});

const validateBatchSize = (nodesWithPortPoints: NodeWithPortPoints[]) => {
  if (nodesWithPortPoints.length === 0) {
    return "nodesWithPortPoints must not be empty.";
  }

  if (nodesWithPortPoints.length > MAX_BATCH_SIZE) {
    return `nodesWithPortPoints may contain at most ${MAX_BATCH_SIZE} nodes.`;
  }

  return null;
};

const getRequestScopedConfig = (request: Request, env: WorkerEnv) => {
  const baseConfig = getSolveWorkerConfig(env);
  const requestUrl = new URL(request.url);
  const rawOverride = requestUrl.searchParams.get("maxCandidatesToTry");

  if (!rawOverride) {
    return baseConfig;
  }

  const parsedOverride = Number.parseInt(rawOverride, 10);
  if (!Number.isFinite(parsedOverride) || parsedOverride <= 0) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    maxCandidatesToTry: parsedOverride,
  };
};

const decodeBinaryBatchPayload = (payload: ArrayBuffer | Uint8Array) => {
  const decodedRequest = decodeBinarySolveBatchRequest(payload);
  const batchSizeError = validateBatchSize(decodedRequest.nodesWithPortPoints);
  if (batchSizeError) {
    throw new Error(batchSizeError);
  }

  return decodedRequest.nodesWithPortPoints;
};

const readBinaryBatchRequest = async (request: Request) => {
  const payload = await request.arrayBuffer();
  return {
    byteLength: payload.byteLength,
    nodesWithPortPoints: decodeBinaryBatchPayload(payload),
  };
};

const buildBatchContext = (nodesWithPortPoints: NodeWithPortPoints[]) => {
  const solveRequests = nodesWithPortPoints.map((nodeWithPortPoints) =>
    canonicalizeSolveRequest(nodeWithPortPoints),
  );
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

  return {
    solveRequests,
    uniqueBuckets,
  };
};

type VectorizeCandidateIds = {
  solveRequest: CanonicalSolveRequest;
  entryIds: string[];
  reportedMatchCount: number;
};

const queryVectorizeForRequests = async (
  solveRequests: CanonicalSolveRequest[],
  env: WorkerEnv,
  topK: number,
) => {
  const queryResults = await Promise.all(
    solveRequests.map(async (solveRequest) => {
      const index = getVectorizeBindingForPairCount(env, solveRequest.pairCount);

      if (!index) {
        return {
          solveRequest,
          entryIds: [],
          reportedMatchCount: 0,
          queried: false,
        };
      }

      const matches = await index.query(
        getVectorizeValuesForVecRaw(solveRequest.vecRaw),
        {
          topK,
          returnMetadata: "none",
          returnValues: false,
        },
      );

      return {
        solveRequest,
        entryIds: matches.matches.map((match) => match.id),
        reportedMatchCount: matches.count,
        queried: true,
      };
    }),
  );

  return {
    candidateIdsByRequest: queryResults.map(
      ({ queried: _queried, ...requestResult }) => requestResult,
    ),
    queriedCount: queryResults.filter((result) => result.queried).length,
    totalReportedMatchCount: queryResults.reduce(
      (totalCount, result) => totalCount + result.reportedMatchCount,
      0,
    ),
  };
};

const fetchVectorizeEntries = async (
  env: WorkerEnv,
  candidateIdsByRequest: VectorizeCandidateIds[],
) => {
  const uniqueEntryIds = [...new Set(
    candidateIdsByRequest.flatMap((requestResult) => requestResult.entryIds),
  )];
  const fetchedEntries = await loadWorkerEntriesByIds(env.SOLVE_CACHE, uniqueEntryIds);
  const entriesById = new Map(
    fetchedEntries.map((entry) => [entry.entryId, entry] as const),
  );

  return {
    uniqueEntryIds,
    fetchedEntries,
    entriesById,
  };
};

const findVectorizeMatchesForRequests = (
  candidateIdsByRequest: VectorizeCandidateIds[],
  entriesById: Map<string, Awaited<ReturnType<typeof loadWorkerEntriesByIds>>[number]>,
  config: ReturnType<typeof getSolveWorkerConfig>,
) => {
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalFetchedEntriesExamined = 0;

  for (const requestResult of candidateIdsByRequest) {
    const candidateEntries = requestResult.entryIds
      .map((entryId) => entriesById.get(entryId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    totalFetchedEntriesExamined += candidateEntries.length;
    const match = findBucketMatch(
      requestResult.solveRequest.canonicalNodeWithPortPoints,
      requestResult.solveRequest.vecRaw,
      candidateEntries,
      config.maxCandidatesToTry,
    );

    if (match) {
      cacheHits += 1;
    } else {
      cacheMisses += 1;
    }
  }

  return {
    cacheHits,
    cacheMisses,
    totalFetchedEntriesExamined,
  };
};

const solveAgainstVectorize = async ({
  solveRequest,
  env,
  config,
}: {
  solveRequest: CanonicalSolveRequest;
  env: WorkerEnv;
  config: ReturnType<typeof getSolveWorkerConfig>;
}) => {
  const requestStart = performance.now();
  const queryStart = performance.now();
  const queryResult = await queryVectorizeForRequests(
    [solveRequest],
    env,
    config.maxCandidatesToTry,
  );
  const queryMs = performance.now() - queryStart;

  const kvGetStart = performance.now();
  const fetchedEntries = await fetchVectorizeEntries(
    env,
    queryResult.candidateIdsByRequest,
  );
  const kvGetMs = performance.now() - kvGetStart;

  const requestVectorizeResult = queryResult.candidateIdsByRequest[0] ?? {
    solveRequest,
    entryIds: [],
    reportedMatchCount: 0,
  };
  const candidateEntries = requestVectorizeResult.entryIds
    .map((entryId) => fetchedEntries.entriesById.get(entryId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  const matchStart = performance.now();
  const match = findBucketMatch(
    solveRequest.canonicalNodeWithPortPoints,
    solveRequest.vecRaw,
    candidateEntries,
    config.maxCandidatesToTry,
  );
  const matchMs = performance.now() - matchStart;
  const rankingMs = queryMs + matchMs;

  if (match) {
    return {
      responseBody: {
        ok: true,
        source: "cache",
        pairCount: solveRequest.pairCount,
        zSignature: solveRequest.zSignature,
        bucketKey: `vectorize:${solveRequest.pairCount}`,
        bucketSize: candidateEntries.length,
        routes: decanonicalizeRoutesForResponse(
          match.routes,
          solveRequest.canonicalization,
        ),
        drc: match.drc,
        timingsMs: {
          total: performance.now() - requestStart,
          kvRead: kvGetMs,
          kvGet: kvGetMs,
          bucketParse: 0,
          ranking: rankingMs,
          cacheApply: matchMs,
        },
      } satisfies SolveResponseBody,
    };
  }

  const solveStart = performance.now();
  const solvedRoutes = solveNodeWithAutorouter(
    solveRequest.canonicalNodeWithPortPoints,
    config,
  );
  const solveMs = performance.now() - solveStart;

  if (!solvedRoutes) {
    return {
      responseBody: {
        ok: true,
        source: "none",
        pairCount: solveRequest.pairCount,
        zSignature: solveRequest.zSignature,
        bucketKey: `vectorize:${solveRequest.pairCount}`,
        bucketSize: candidateEntries.length,
        routes: null,
        drc: null,
        solverSolved: false,
        message: "Solver did not find a solution.",
        timingsMs: {
          total: performance.now() - requestStart,
          kvRead: kvGetMs,
          kvGet: kvGetMs,
          bucketParse: 0,
          ranking: rankingMs,
          solve: solveMs,
        },
      } satisfies SolveResponseBody,
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
        bucketKey: `vectorize:${solveRequest.pairCount}`,
        bucketSize: candidateEntries.length,
        routes: null,
        drc: null,
        solverSolved: true,
        message: "Solver produced routes, but they failed validation.",
        timingsMs: {
          total: performance.now() - requestStart,
          kvRead: kvGetMs,
          kvGet: kvGetMs,
          bucketParse: 0,
          ranking: rankingMs,
          solve: solveMs,
        },
      } satisfies SolveResponseBody,
    };
  }

  const expandedEntries = expandEntryIntoWorkerBuckets(validatedEntry);
  const kvWriteStart = performance.now();
  await saveWorkerEntries(env.SOLVE_CACHE, expandedEntries);
  await upsertEntriesIntoVectorize(env, solveRequest.pairCount, expandedEntries);
  const kvWriteMs = performance.now() - kvWriteStart;

  return {
    responseBody: {
      ok: true,
      source: "solver",
      pairCount: solveRequest.pairCount,
      zSignature: solveRequest.zSignature,
      bucketKey: `vectorize:${solveRequest.pairCount}`,
      bucketSize: candidateEntries.length,
      routes: decanonicalizeRoutesForResponse(
        validatedEntry.solution,
        solveRequest.canonicalization,
      ),
      drc: null,
      solverSolved: true,
      timingsMs: {
        total: performance.now() - requestStart,
        kvRead: kvGetMs,
        kvGet: kvGetMs,
        bucketParse: 0,
        ranking: rankingMs,
        solve: solveMs,
        kvWrite: kvWriteMs,
      },
    } satisfies SolveResponseBody,
  };
};

const solveBatchNodes = async (
  nodesWithPortPoints: NodeWithPortPoints[],
  env: WorkerEnv,
  config: ReturnType<typeof getSolveWorkerConfig>,
) => {
  const totalStart = performance.now();
  const canonicalizeStart = performance.now();
  const batchContext = buildBatchContext(nodesWithPortPoints);
  const canonicalizeMs = performance.now() - canonicalizeStart;

  const results: SolveResponseBody[] = [];
  let cacheCount = 0;
  let solverCount = 0;
  let noneCount = 0;
  let kvReadMs = 0;
  let kvGetMs = 0;
  let rankingMs = 0;
  let solveMs = 0;
  let kvWriteMs = 0;

  for (const solveRequest of batchContext.solveRequests) {
    const result = await solveAgainstVectorize({
      solveRequest,
      env,
      config,
    });

    results.push(result.responseBody);
    kvReadMs += result.responseBody.timingsMs.kvRead ?? 0;
    kvGetMs += result.responseBody.timingsMs.kvGet ?? 0;
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
  }

  return {
    count: results.length,
    uniqueBucketCount: batchContext.uniqueBuckets.size,
    results,
    summary: {
      cache: cacheCount,
      solver: solverCount,
      none: noneCount,
    },
    timingsMs: {
      total: performance.now() - totalStart,
      canonicalize: canonicalizeMs,
      kvRead: kvReadMs,
      kvGet: kvGetMs,
      bucketParse: 0,
      ranking: rankingMs,
      solve: solveMs,
      kvWrite: kvWriteMs,
    },
  };
};

const handleSolveRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestDecodeStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveBatchRequestBody> & {
    nodeWithPortPoints?: unknown;
  };
  const requestDecodeMs = performance.now() - requestDecodeStart;
  const rawNodeWithPortPoints = requestBody.nodeWithPortPoints;

  if (!rawNodeWithPortPoints || typeof rawNodeWithPortPoints !== "object") {
    return errorResponse(400, "Request body must include nodeWithPortPoints.");
  }

  const config = getRequestScopedConfig(request, env);
  const solveRequest = canonicalizeSolveRequest(rawNodeWithPortPoints as never);

  const result = await solveAgainstVectorize({
    solveRequest,
    env,
    config,
  });

  const responseBody: SolveResponseBody = {
    ...result.responseBody,
    timingsMs: {
      ...result.responseBody.timingsMs,
      total: performance.now() - totalStart,
      requestDecode: requestDecodeMs,
    },
  };

  return jsonResponse(responseBody);
};

const handleSolveBatchRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestDecodeStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveBatchRequestBody>;
  const requestDecodeMs = performance.now() - requestDecodeStart;

  if (!Array.isArray(requestBody.nodesWithPortPoints)) {
    return errorResponse(400, "Request body must include nodesWithPortPoints.");
  }

  const batchSizeError = validateBatchSize(requestBody.nodesWithPortPoints);
  if (batchSizeError) {
    return errorResponse(400, batchSizeError);
  }

  const responseMode = requestBody.responseMode ?? "compact";
  const config = getRequestScopedConfig(request, env);
  const batchResult = await solveBatchNodes(
    requestBody.nodesWithPortPoints,
    env,
    config,
  );

  const responseBody: SolveBatchResponseBody = {
    ok: true,
    count: batchResult.count,
    uniqueBucketCount: batchResult.uniqueBucketCount,
    results:
      responseMode === "full"
        ? batchResult.results
        : batchResult.results.map((result) => toCompactSolveBatchResult(result)),
    summary: batchResult.summary,
    timingsMs: {
      ...batchResult.timingsMs,
      requestDecode: requestDecodeMs,
      total: performance.now() - totalStart,
    },
  };

  return jsonResponse(responseBody);
};

const handleSolveBatchBinaryRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  let nodesWithPortPoints: NodeWithPortPoints[];

  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    nodesWithPortPoints = decodedRequest.nodesWithPortPoints;
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }

  const config = getRequestScopedConfig(request, env);
  const batchResult = await solveBatchNodes(nodesWithPortPoints, env, config);

  return binaryResponse(
    request,
    encodeBinarySolveBatchResponse({
      ...batchResult,
      timingsMs: {
        ...batchResult.timingsMs,
        requestDecode: 0,
      },
      traceThickness: config.traceWidth,
      viaDiameter: config.viaDiameter,
    }),
  );
};

const handleDebugStageDecodeBinaryRequest = async (request: Request) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    return jsonResponse({
      ok: true,
      byteLength: decodedRequest.byteLength,
      count: decodedRequest.nodesWithPortPoints.length,
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleDebugStageCanonicalizeBinaryRequest = async (
  request: Request,
) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    const batchContext = buildBatchContext(decodedRequest.nodesWithPortPoints);

    return jsonResponse({
      ok: true,
      byteLength: decodedRequest.byteLength,
      count: batchContext.solveRequests.length,
      uniqueBucketCount: batchContext.uniqueBuckets.size,
      bucketKeys: [...batchContext.uniqueBuckets.keys()],
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleDebugStageSolveBatchLiteBinaryRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    const config = getRequestScopedConfig(request, env);
    const batchResult = await solveBatchNodes(
      decodedRequest.nodesWithPortPoints,
      env,
      config,
    );

    return jsonResponse({
      ok: true,
      count: batchResult.count,
      uniqueBucketCount: batchResult.uniqueBucketCount,
      summary: batchResult.summary,
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleDebugStageVectorizeQueryBinaryRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    const batchContext = buildBatchContext(decodedRequest.nodesWithPortPoints);
    const config = getRequestScopedConfig(request, env);
    const queryResult = await queryVectorizeForRequests(
      batchContext.solveRequests,
      env,
      config.maxCandidatesToTry,
    );

    return jsonResponse({
      ok: true,
      count: batchContext.solveRequests.length,
      queriedCount: queryResult.queriedCount,
      totalReportedMatchCount: queryResult.totalReportedMatchCount,
      totalRequestedCandidateIds: queryResult.candidateIdsByRequest.reduce(
        (totalCount, requestResult) => totalCount + requestResult.entryIds.length,
        0,
      ),
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleDebugStageVectorizeFetchBinaryRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    const batchContext = buildBatchContext(decodedRequest.nodesWithPortPoints);
    const config = getRequestScopedConfig(request, env);
    const queryResult = await queryVectorizeForRequests(
      batchContext.solveRequests,
      env,
      config.maxCandidatesToTry,
    );
    const fetchedEntries = await fetchVectorizeEntries(
      env,
      queryResult.candidateIdsByRequest,
    );

    return jsonResponse({
      ok: true,
      count: batchContext.solveRequests.length,
      queriedCount: queryResult.queriedCount,
      totalReportedMatchCount: queryResult.totalReportedMatchCount,
      uniqueFetchedEntryCount: fetchedEntries.uniqueEntryIds.length,
      fetchedEntryCount: fetchedEntries.fetchedEntries.length,
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleDebugStageVectorizeMatchBinaryRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  try {
    const decodedRequest = await readBinaryBatchRequest(request);
    const batchContext = buildBatchContext(decodedRequest.nodesWithPortPoints);
    const config = getRequestScopedConfig(request, env);
    const queryResult = await queryVectorizeForRequests(
      batchContext.solveRequests,
      env,
      config.maxCandidatesToTry,
    );
    const fetchedEntries = await fetchVectorizeEntries(
      env,
      queryResult.candidateIdsByRequest,
    );
    const matchResult = findVectorizeMatchesForRequests(
      queryResult.candidateIdsByRequest,
      fetchedEntries.entriesById,
      config,
    );

    return jsonResponse({
      ok: true,
      count: batchContext.solveRequests.length,
      queriedCount: queryResult.queriedCount,
      totalReportedMatchCount: queryResult.totalReportedMatchCount,
      uniqueFetchedEntryCount: fetchedEntries.uniqueEntryIds.length,
      fetchedEntryCount: fetchedEntries.fetchedEntries.length,
      totalFetchedEntriesExamined: matchResult.totalFetchedEntriesExamined,
      cacheHits: matchResult.cacheHits,
      cacheMisses: matchResult.cacheMisses,
    });
  } catch (error) {
    return errorResponse(
      400,
      error instanceof Error ? error.message : "Invalid binary solve-batch request.",
    );
  }
};

const handleUpsertVectorizeEntriesRequest = async (
  request: Request,
  env: WorkerEnv,
) => {
  const authError = requireAdminToken(request, env);
  if (authError) {
    return authError;
  }

  const requestBody = (await request.json()) as UpsertVectorizeEntriesRequestBody;
  if (
    !Number.isInteger(requestBody.pointPairCount) ||
    requestBody.pointPairCount <= 0
  ) {
    return errorResponse(400, "pointPairCount must be a positive integer.");
  }

  if (!Array.isArray(requestBody.entries)) {
    return errorResponse(400, "entries must be an array.");
  }

  await saveWorkerEntries(env.SOLVE_CACHE, requestBody.entries);
  await upsertEntriesIntoVectorize(
    env,
    requestBody.pointPairCount,
    requestBody.entries,
  );

  return jsonResponse({
    ok: true,
    pointPairCount: requestBody.pointPairCount,
    entryCount: requestBody.entries.length,
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

    if (request.method === "GET" && requestUrl.pathname === "/debug/kv-read") {
      return handleDebugKvReadRequest(env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/echo-binary"
    ) {
      return handleDebugEchoBinaryRequest(request);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/echo-json"
    ) {
      return handleDebugEchoJsonRequest(request);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/decode-binary"
    ) {
      return handleDebugStageDecodeBinaryRequest(request);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/canonicalize-binary"
    ) {
      return handleDebugStageCanonicalizeBinaryRequest(request);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/solve-batch-lite-binary"
    ) {
      return handleDebugStageSolveBatchLiteBinaryRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/vectorize-query-binary"
    ) {
      return handleDebugStageVectorizeQueryBinaryRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/vectorize-fetch-binary"
    ) {
      return handleDebugStageVectorizeFetchBinaryRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/debug/stage/vectorize-match-binary"
    ) {
      return handleDebugStageVectorizeMatchBinaryRequest(request, env);
    }

    if (request.method === "POST" && requestUrl.pathname === "/solve") {
      return handleSolveRequest(request, env);
    }

    if (request.method === "POST" && requestUrl.pathname === "/solve-batch") {
      return handleSolveBatchRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/solve-batch-binary"
    ) {
      return handleSolveBatchBinaryRequest(request, env);
    }

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/admin/upsert-vectorize-entries"
    ) {
      return handleUpsertVectorizeEntriesRequest(request, env);
    }

    return errorResponse(404, "Not found.");
  },
};
