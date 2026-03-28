import {
  canonicalizeSolveRequest,
  decanonicalizeRoutesForResponse,
  findBucketMatch,
  getSolveWorkerConfig,
  loadWorkerBucket,
  mergeEntriesIntoBucket,
  solveNodeWithAutorouter,
  upsertValidatedEntryAcrossBuckets,
  validateSolvedEntry,
} from "./cache-logic";
import type {
  SolveResponseBody,
  UpsertBucketRequestBody,
  WorkerEnv,
  WorkerExecutionContext,
} from "./contracts";

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

const handleSolveRequest = async (request: Request, env: WorkerEnv) => {
  const totalStart = performance.now();
  const requestBody = (await request.json()) as {
    nodeWithPortPoints?: unknown;
  };
  const rawNodeWithPortPoints = requestBody.nodeWithPortPoints;

  if (!rawNodeWithPortPoints || typeof rawNodeWithPortPoints !== "object") {
    return errorResponse(400, "Request body must include nodeWithPortPoints.");
  }

  const config = getSolveWorkerConfig(env);
  const solveRequest = canonicalizeSolveRequest(rawNodeWithPortPoints as never);

  const kvReadStart = performance.now();
  const bucket = await loadWorkerBucket(
    env.SOLVE_CACHE,
    solveRequest.pairCount,
    solveRequest.zSignature,
  );
  const kvReadEnd = performance.now();

  const rankingStart = performance.now();
  const match = findBucketMatch(
    solveRequest.canonicalNodeWithPortPoints,
    solveRequest.vecRaw,
    bucket.entries,
    config.maxCandidatesToTry,
  );
  const rankingEnd = performance.now();

  if (match) {
    const responseBody: SolveResponseBody = {
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
        total: performance.now() - totalStart,
        kvRead: kvReadEnd - kvReadStart,
        ranking: rankingEnd - rankingStart,
        cacheApply: rankingEnd - rankingStart,
      },
    };

    return jsonResponse(responseBody);
  }

  const solveStart = performance.now();
  const solvedRoutes = solveNodeWithAutorouter(
    solveRequest.canonicalNodeWithPortPoints,
    config,
  );
  const solveEnd = performance.now();

  if (!solvedRoutes) {
    const responseBody: SolveResponseBody = {
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
        total: performance.now() - totalStart,
        kvRead: kvReadEnd - kvReadStart,
        ranking: rankingEnd - rankingStart,
        solve: solveEnd - solveStart,
      },
    };

    return jsonResponse(responseBody);
  }

  const validatedEntry = validateSolvedEntry(
    solveRequest.canonicalNodeWithPortPoints,
    solvedRoutes,
  );

  if (!validatedEntry) {
    const responseBody: SolveResponseBody = {
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
        total: performance.now() - totalStart,
        kvRead: kvReadEnd - kvReadStart,
        ranking: rankingEnd - rankingStart,
        solve: solveEnd - solveStart,
      },
    };

    return jsonResponse(responseBody);
  }

  const kvWriteStart = performance.now();
  await upsertValidatedEntryAcrossBuckets(env.SOLVE_CACHE, validatedEntry);
  const kvWriteEnd = performance.now();

  const responseBody: SolveResponseBody = {
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
      total: performance.now() - totalStart,
      kvRead: kvReadEnd - kvReadStart,
      ranking: rankingEnd - rankingStart,
      solve: solveEnd - solveStart,
      kvWrite: kvWriteEnd - kvWriteStart,
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

    if (
      request.method === "POST" &&
      requestUrl.pathname === "/admin/upsert-bucket"
    ) {
      return handleUpsertBucketRequest(request, env);
    }

    return errorResponse(404, "Not found.");
  },
};
