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
import type {
  SolveRequestBody,
  SolveResponseBody,
  UpsertVectorizeEntriesRequestBody,
  WorkerEnv,
  WorkerExecutionContext,
} from "./contracts";

const KV_PING_KEY = "__kv_ping__";

type CanonicalSolveRequest = ReturnType<typeof canonicalizeSolveRequest>;

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

const queryVectorizeForRequest = async (
  solveRequest: CanonicalSolveRequest,
  env: WorkerEnv,
  topK: number,
) => {
  const index = getVectorizeBindingForPairCount(env, solveRequest.pairCount);

  if (!index) {
    return {
      entryIds: [] as string[],
      reportedMatchCount: 0,
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
    entryIds: matches.matches.map((match) => match.id),
    reportedMatchCount: matches.count,
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
  const queryResult = await queryVectorizeForRequest(
    solveRequest,
    env,
    config.maxCandidatesToTry,
  );
  const queryMs = performance.now() - queryStart;

  const kvGetStart = performance.now();
  const fetchedEntries = await loadWorkerEntriesByIds(
    env.SOLVE_CACHE,
    queryResult.entryIds,
  );
  const kvGetMs = performance.now() - kvGetStart;

  const matchStart = performance.now();
  const match = findBucketMatch(
    solveRequest.canonicalNodeWithPortPoints,
    solveRequest.vecRaw,
    fetchedEntries,
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
        bucketSize: fetchedEntries.length,
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
        bucketSize: fetchedEntries.length,
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
        bucketSize: fetchedEntries.length,
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
      bucketSize: fetchedEntries.length,
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

const handleSolveRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestDecodeStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveRequestBody>;
  const requestDecodeMs = performance.now() - requestDecodeStart;
  const rawNodeWithPortPoints = requestBody.nodeWithPortPoints;

  if (!rawNodeWithPortPoints || typeof rawNodeWithPortPoints !== "object") {
    return errorResponse(400, "Request body must include nodeWithPortPoints.");
  }

  const config = getRequestScopedConfig(request, env);
  const solveRequest = canonicalizeSolveRequest(
    rawNodeWithPortPoints as SolveRequestBody["nodeWithPortPoints"],
  );

  const result = await solveAgainstVectorize({
    solveRequest,
    env,
    config,
  });

  return jsonResponse({
    ...result.responseBody,
    timingsMs: {
      ...result.responseBody.timingsMs,
      total: performance.now() - totalStart,
      requestDecode: requestDecodeMs,
    },
  } satisfies SolveResponseBody);
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

    if (request.method === "POST" && requestUrl.pathname === "/solve") {
      return handleSolveRequest(request, env);
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
