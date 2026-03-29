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
import {
  decodeBinarySolveBatchRequest,
  encodeBinarySolveBatchResponse,
} from "./binary";
import type {
  SolveBatchRequestBody,
  SolveBatchResponseBody,
  SolveResponseBody,
  SolveTimingBreakdown,
  UpsertBucketRequestBody,
  WorkerEnv,
  WorkerExecutionContext,
} from "./contracts";
import type { NodeWithPortPoints } from "../../lib/types";

const MAX_BATCH_SIZE = 64;
const KV_PING_KEY = "__kv_ping__";

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
  const totalStart = performance.now();
  const kvGetStart = performance.now();
  const value = await env.SOLVE_CACHE.get(KV_PING_KEY, "text");
  const kvGetEnd = performance.now();

  return jsonResponse({
    ok: true,
    key: KV_PING_KEY,
    hasValue: value !== null,
    valueLength: value?.length ?? 0,
    timingsMs: {
      total: performance.now() - totalStart,
      kvGet: kvGetEnd - kvGetStart,
    },
  });
};

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

const websocketErrorMessage = (message: string) =>
  JSON.stringify({
    ok: false,
    message,
  });

const WebSocketPairCtor = (
  globalThis as typeof globalThis & {
    WebSocketPair: new () => {
      0: WebSocket;
      1: WebSocket & { accept(): void };
    };
  }
).WebSocketPair;

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
  const requestDecodeStart = performance.now();
  const requestBody = (await request.json()) as Partial<SolveBatchRequestBody> & {
    nodeWithPortPoints?: unknown;
  };
  const requestDecodeMs = performance.now() - requestDecodeStart;
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
  result.responseBody.timingsMs.requestDecode = requestDecodeMs;

  return jsonResponse(result.responseBody);
};

const validateBatchSize = (nodesWithPortPoints: NodeWithPortPoints[]) => {
  if (nodesWithPortPoints.length === 0) {
    return "nodesWithPortPoints must not be empty.";
  }

  if (nodesWithPortPoints.length > MAX_BATCH_SIZE) {
    return `nodesWithPortPoints may contain at most ${MAX_BATCH_SIZE} nodes.`;
  }

  return null;
};

const solveBatchNodes = async (
  nodesWithPortPoints: NodeWithPortPoints[],
  env: WorkerEnv,
  config: ReturnType<typeof getSolveWorkerConfig>,
) => {
  const totalStart = performance.now();
  const canonicalizeStart = performance.now();
  const solveRequests = nodesWithPortPoints.map((nodeWithPortPoints) =>
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

  return {
    count: results.length,
    uniqueBucketCount: uniqueBuckets.size,
    results,
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
  const config = getSolveWorkerConfig(env);
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
  const binaryResult = await solveBatchBinaryPayload(await request.arrayBuffer(), env);

  if (!binaryResult.ok) {
    return errorResponse(binaryResult.status, binaryResult.message);
  }

  return binaryResponse(request, binaryResult.body);
};

const solveBatchBinaryPayload = async (
  payload: ArrayBuffer | Uint8Array,
  env: WorkerEnv,
) => {
  let nodesWithPortPoints: NodeWithPortPoints[];
  const totalStart = performance.now();
  const requestDecodeStart = performance.now();

  try {
    const decodedRequest = decodeBinarySolveBatchRequest(payload);
    nodesWithPortPoints = decodedRequest.nodesWithPortPoints;
  } catch (error) {
    return {
      ok: false as const,
      status: 400,
      message:
        error instanceof Error
          ? error.message
          : "Invalid binary solve-batch request.",
    };
  }
  const requestDecodeMs = performance.now() - requestDecodeStart;

  const batchSizeError = validateBatchSize(nodesWithPortPoints);
  if (batchSizeError) {
    return {
      ok: false as const,
      status: 400,
      message: batchSizeError,
    };
  }

  const config = getSolveWorkerConfig(env);
  const batchResult = await solveBatchNodes(nodesWithPortPoints, env, config);

  try {
    return {
      ok: true as const,
      body: encodeBinarySolveBatchResponse({
        ...batchResult,
        timingsMs: {
          ...batchResult.timingsMs,
          requestDecode: requestDecodeMs,
          total: performance.now() - totalStart,
        },
        traceThickness: config.traceWidth,
        viaDiameter: config.viaDiameter,
      }),
    };
  } catch (error) {
    return {
      ok: false as const,
      status: 500,
      message:
        error instanceof Error
          ? error.message
          : "Failed to serialize binary solve-batch response.",
    };
  }
};

const handleSolveBatchBinaryWebSocket = (request: Request, env: WorkerEnv) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(426, "Expected Upgrade: websocket.");
  }

  const webSocketPair = new WebSocketPairCtor();
  const client = webSocketPair[0];
  const server = webSocketPair[1];

  server.accept();

  server.addEventListener("message", async (event: MessageEvent) => {
    try {
      let payload: ArrayBuffer | Uint8Array | null = null;

      if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
        payload = event.data;
      } else if (event.data instanceof Blob) {
        payload = await event.data.arrayBuffer();
      }

      if (!payload) {
        server.send(
          websocketErrorMessage(
            "Binary WebSocket messages are required for /ws/solve-batch-binary.",
          ),
        );
        return;
      }

      const binaryResult = await solveBatchBinaryPayload(payload, env);
      if (!binaryResult.ok) {
        server.send(websocketErrorMessage(binaryResult.message));
        return;
      }

      server.send(binaryResult.body.buffer.slice(
        binaryResult.body.byteOffset,
        binaryResult.body.byteOffset + binaryResult.body.byteLength,
      ));
    } catch (error) {
      server.send(
        websocketErrorMessage(
          error instanceof Error
            ? error.message
            : "Unexpected websocket solve-batch failure.",
        ),
      );
    }
  });

  server.addEventListener("close", () => {
    server.close();
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
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

    if (request.method === "GET" && requestUrl.pathname === "/debug/kv-read") {
      return handleDebugKvReadRequest(env);
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
      request.method === "GET" &&
      requestUrl.pathname === "/ws/solve-batch-binary"
    ) {
      return handleSolveBatchBinaryWebSocket(request, env);
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
