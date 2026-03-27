import { readFile, readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Connect } from "vite";
import type { Plugin } from "vite";
import {
  SAMPLE_FILE_PATTERN,
  SIMPLIFIED_SAMPLES_DIR_NAME,
} from "./sample-directories";
import {
  type SolveCacheFile,
  canonicalizeDatasetSample,
  getSolveCacheCandidates,
  parseSolveCacheFile,
  tryApplySolveCacheEntry,
} from "./solve-cache";
import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "./types";
import { computeVecRaw } from "./vec-raw";
import {
  type SampleRawVecIndexEntry,
  getVectorDistance,
} from "./vector-search";

const API_PATH = "/api/get_nearest_neighbor";
const SOLVE_CACHE_MATCH_API_PATH = "/api/get_nearest_solve_cache_match";
const SAMPLE_RAW_VEC_INDEX_FILE_NAME = "sample-raw-vec-index.json";

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
    );
  }

  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) => {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
};

const loadIndexEntries = async (
  rootDir: string,
): Promise<SampleRawVecIndexEntry[]> => {
  const indexPath = join(rootDir, SAMPLE_RAW_VEC_INDEX_FILE_NAME);

  try {
    const rawIndex = await readFile(indexPath, "utf8");
    return JSON.parse(rawIndex) as SampleRawVecIndexEntry[];
  } catch {
    const samplesDir = join(rootDir, SIMPLIFIED_SAMPLES_DIR_NAME);
    const fileNames = (await readdir(samplesDir))
      .filter((fileName) => SAMPLE_FILE_PATTERN.test(fileName))
      .sort();

    const entries: SampleRawVecIndexEntry[] = [];

    for (const fileName of fileNames) {
      const samplePath = join(samplesDir, fileName);
      const sample = JSON.parse(
        await readFile(samplePath, "utf8"),
      ) as DatasetSample;
      entries.push({
        fileName,
        vecRaw: sample.vecRaw ?? computeVecRaw(sample),
      });
    }

    return entries;
  }
};

export const createNearestNeighborVitePlugin = (): Plugin => {
  let cachedIndex: SampleRawVecIndexEntry[] | null = null;
  let cachedRootDir: string | null = null;
  let cachedIndexMtimeMs: number | null = null;
  const cachedSolveCaches = new Map<
    string,
    {
      rootDir: string;
      mtimeMs: number;
      solveCache: SolveCacheFile;
    }
  >();

  const getIndex = async (rootDir: string) => {
    const indexPath = join(rootDir, SAMPLE_RAW_VEC_INDEX_FILE_NAME);
    let currentIndexMtimeMs: number | null = null;

    try {
      const indexStats = await stat(indexPath);
      currentIndexMtimeMs = indexStats.mtimeMs;
    } catch {
      currentIndexMtimeMs = null;
    }

    if (
      cachedIndex &&
      cachedRootDir === rootDir &&
      cachedIndexMtimeMs === currentIndexMtimeMs
    ) {
      return cachedIndex;
    }

    cachedIndex = await loadIndexEntries(rootDir);
    cachedRootDir = rootDir;
    cachedIndexMtimeMs = currentIndexMtimeMs;
    return cachedIndex;
  };

  const getSolveCache = async (rootDir: string, pointPairCount: number) => {
    const fileName = `solve-cache-${pointPairCount}.json`;
    const cachePath = join(rootDir, fileName);

    let cacheStats: Awaited<ReturnType<typeof stat>>;
    try {
      cacheStats = await stat(cachePath);
    } catch {
      throw new Error(`Missing solve cache file ${fileName}`);
    }

    const cacheKey = `${rootDir}:${pointPairCount}`;
    const cachedSolveCache = cachedSolveCaches.get(cacheKey);

    if (
      cachedSolveCache &&
      cachedSolveCache.rootDir === rootDir &&
      cachedSolveCache.mtimeMs === cacheStats.mtimeMs
    ) {
      return cachedSolveCache.solveCache;
    }

    const rawSolveCache = await readFile(cachePath, "utf8");
    const solveCache = parseSolveCacheFile(
      JSON.parse(rawSolveCache),
      pointPairCount,
    );

    cachedSolveCaches.set(cacheKey, {
      rootDir,
      mtimeMs: cacheStats.mtimeMs,
      solveCache,
    });

    return solveCache;
  };

  const getDatasetSampleFromNode = (
    nodeWithPortPoints: NodeWithPortPoints,
    solution: HighDensityIntraNodeRoute[] | null,
  ): DatasetSample => ({
    ...nodeWithPortPoints,
    solvable: solution !== null,
    solution,
    vecRaw: computeVecRaw({
      ...nodeWithPortPoints,
      solvable: false,
      solution: null,
    }),
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    rootDir: string,
  ) => {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, {
        error: "Use POST for nearest-neighbor lookups",
      });
      return;
    }

    try {
      const body = await readRequestBody(request);
      const payload = JSON.parse(body) as { rawVec?: number[] };
      const rawVec = payload.rawVec;

      if (
        !Array.isArray(rawVec) ||
        rawVec.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
      ) {
        sendJson(response, 400, {
          error: "rawVec must be an array of numbers",
        });
        return;
      }

      const index = await getIndex(rootDir);
      let nearest: (SampleRawVecIndexEntry & { distance: number }) | null =
        null;

      for (const entry of index) {
        if (entry.vecRaw.length !== rawVec.length) {
          continue;
        }

        const distance = getVectorDistance(rawVec, entry.vecRaw);
        if (!nearest || distance < nearest.distance) {
          nearest = {
            ...entry,
            distance,
          };
        }
      }

      if (!nearest) {
        sendJson(response, 404, {
          error: `No simplified samples matched vecRaw length ${rawVec.length}`,
        });
        return;
      }

      const samplePath = join(
        rootDir,
        SIMPLIFIED_SAMPLES_DIR_NAME,
        nearest.fileName,
      );
      const sample = JSON.parse(
        await readFile(samplePath, "utf8"),
      ) as DatasetSample;

      sendJson(response, 200, {
        fileName: nearest.fileName,
        distance: nearest.distance,
        sample,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  };

  const handleSolveCacheMatchRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
    rootDir: string,
  ) => {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, {
        error: "Use POST for solve-cache lookups",
      });
      return;
    }

    try {
      const body = await readRequestBody(request);
      const payload = JSON.parse(body) as {
        pointPairCount?: number;
        sample?: DatasetSample;
      };
      const pointPairCount = payload.pointPairCount;
      const sample = payload.sample;

      if (
        typeof pointPairCount !== "number" ||
        !Number.isInteger(pointPairCount) ||
        pointPairCount <= 0
      ) {
        sendJson(response, 400, {
          error: "pointPairCount must be a positive integer",
        });
        return;
      }

      if (
        !sample ||
        typeof sample !== "object" ||
        !Array.isArray(sample.portPoints)
      ) {
        sendJson(response, 400, {
          error: "sample must be a DatasetSample-like object",
        });
        return;
      }

      const canonicalSample = canonicalizeDatasetSample(sample);
      const solveCache = await getSolveCache(rootDir, pointPairCount);
      const candidates = getSolveCacheCandidates(
        canonicalSample,
        solveCache.entries,
      );
      const nearest = candidates[0];

      if (!nearest) {
        sendJson(response, 404, {
          error: `No solve-cache entries matched vecRaw length ${canonicalSample.vecRaw?.length ?? computeVecRaw(canonicalSample).length}`,
        });
        return;
      }

      const appliedSolveCacheEntry = tryApplySolveCacheEntry(
        canonicalSample,
        nearest.entry,
      );
      const entryIndex = solveCache.entries.indexOf(nearest.sourceEntry);

      sendJson(response, 200, {
        entryIndex,
        distance: nearest.distance,
        symmetry: nearest.symmetry,
        cacheSample: getDatasetSampleFromNode(
          nearest.entry.sample,
          nearest.entry.solution,
        ),
        appliedRoutes: appliedSolveCacheEntry?.routes ?? null,
        applyError: appliedSolveCacheEntry
          ? null
          : "Nearest solve-cache entry failed reattachment or DRC",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: message });
    }
  };

  const createMiddleware =
    (rootDir: string): Connect.NextHandleFunction =>
    (request, response, next) => {
      const requestUrl = request.url
        ? new URL(request.url, "http://localhost")
        : null;

      if (!requestUrl) {
        next();
        return;
      }

      if (requestUrl.pathname === API_PATH) {
        void handleRequest(request, response, rootDir);
        return;
      }

      if (requestUrl.pathname === SOLVE_CACHE_MATCH_API_PATH) {
        void handleSolveCacheMatchRequest(request, response, rootDir);
        return;
      }

      next();
    };

  return {
    name: "nearest-neighbor-api",
    configureServer(server) {
      server.middlewares.use(createMiddleware(server.config.root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createMiddleware(server.config.root));
    },
  };
};
