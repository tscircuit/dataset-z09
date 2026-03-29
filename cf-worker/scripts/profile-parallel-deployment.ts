import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { NodeWithPortPoints } from "../../lib/types";
import { encodeBinarySolveBatchRequest } from "../src/binary";

const DEFAULT_PAIR_COUNT = 4;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_REPEAT_COUNT = 3;
const DEFAULT_CONCURRENCY_LEVELS = [8, 16, 32] as const;
const DEFAULT_ENDPOINTS = [
  "/debug/stage/vectorize-match-binary",
  "/solve-batch-binary",
] as const;

const parseFlagValue = (argv: string[], flagName: string) => {
  const flagIndex = argv.findIndex((argument) => argument === flagName);
  return flagIndex === -1 ? undefined : argv[flagIndex + 1];
};

const parseIntegerFlag = (
  argv: string[],
  flagName: string,
  defaultValue: number,
) => {
  const rawValue = parseFlagValue(argv, flagName);
  if (!rawValue) return defaultValue;

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${flagName} value: ${rawValue}`);
  }

  return parsedValue;
};

const requireFlagValue = (argv: string[], flagName: string) => {
  const value = parseFlagValue(argv, flagName);
  if (!value) {
    throw new Error(`Missing required ${flagName} flag.`);
  }

  return value;
};

const parseListFlag = (
  argv: string[],
  flagName: string,
  defaultValue: readonly string[],
) => {
  const rawValue = parseFlagValue(argv, flagName);
  if (!rawValue) {
    return [...defaultValue];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
};

const parseIntegerListFlag = (
  argv: string[],
  flagName: string,
  defaultValue: readonly number[],
) => {
  const rawValue = parseFlagValue(argv, flagName);
  if (!rawValue) {
    return [...defaultValue];
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      const parsedValue = Number.parseInt(value, 10);
      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Invalid ${flagName} value: ${value}`);
      }
      return parsedValue;
    });
};

const percentile = (sortedValues: number[], percentileValue: number) => {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(
      0,
      Math.round(((percentileValue / 100) * (sortedValues.length - 1))),
    ),
  );
  return sortedValues[index] ?? 0;
};

const computeStats = (values: number[]) => {
  const sortedValues = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    avg: values.length === 0 ? 0 : sum / values.length,
    min: sortedValues[0] ?? 0,
    p50: percentile(sortedValues, 50),
    p95: percentile(sortedValues, 95),
    max: sortedValues.at(-1) ?? 0,
  };
};

const toNodeWithPortPoints = (
  sample: ReturnType<typeof canonicalizeDatasetSample>,
): NodeWithPortPoints => ({
  capacityMeshNodeId: sample.capacityMeshNodeId,
  center: sample.center,
  width: sample.width,
  height: sample.height,
  portPoints: sample.portPoints,
  ...(sample.availableZ ? { availableZ: sample.availableZ } : {}),
});

const postBinaryJsonEndpoint = async (
  deploymentUrl: string,
  pathName: string,
  requestBody: ArrayBuffer,
) => {
  const startedAt = performance.now();
  const response = await fetch(`${deploymentUrl}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: requestBody,
  });
  if (pathName.startsWith("/solve-batch-binary")) {
    const bodyBuffer = await response.arrayBuffer();
    const endedAt = performance.now();

    if (!response.ok) {
      throw new Error(
        `${pathName} failed: ${response.status} ${new TextDecoder().decode(bodyBuffer)}`,
      );
    }

    return {
      elapsedMs: endedAt - startedAt,
      body: {
        ok: true,
        responseByteLength: bodyBuffer.byteLength,
      } as Record<string, unknown>,
    };
  }

  const bodyText = await response.text();
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(`${pathName} failed: ${response.status} ${bodyText}`);
  }

  return {
    elapsedMs: endedAt - startedAt,
    body: JSON.parse(bodyText) as Record<string, unknown>,
  };
};

const runConcurrentSingles = async (
  deploymentUrl: string,
  pathName: string,
  singleRequestBodies: ArrayBuffer[],
  concurrency: number,
) => {
  const startedAt = performance.now();
  const results = new Array<Awaited<ReturnType<typeof postBinaryJsonEndpoint>>>(
    singleRequestBodies.length,
  );
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, singleRequestBodies.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const requestIndex = nextIndex;
        nextIndex += 1;

        if (requestIndex >= singleRequestBodies.length) {
          return;
        }

        results[requestIndex] = await postBinaryJsonEndpoint(
          deploymentUrl,
          pathName,
          singleRequestBodies[requestIndex]!,
        );
      }
    }),
  );
  const endedAt = performance.now();

  return {
    wallMs: endedAt - startedAt,
    perRequestLatencies: results.map((result) => result!.elapsedMs),
    lastBody: results.at(-1)?.body ?? null,
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deploymentUrl = requireFlagValue(argv, "--url").replace(/\/$/, "");
  const pairCount = parseIntegerFlag(argv, "--pair-count", DEFAULT_PAIR_COUNT);
  const batchSize = parseIntegerFlag(argv, "--batch-size", DEFAULT_BATCH_SIZE);
  const repeatCount = parseIntegerFlag(
    argv,
    "--repeat-count",
    DEFAULT_REPEAT_COUNT,
  );
  const endpoints = parseListFlag(argv, "--endpoints", DEFAULT_ENDPOINTS);
  const concurrencyLevels = parseIntegerListFlag(
    argv,
    "--concurrency-levels",
    DEFAULT_CONCURRENCY_LEVELS,
  );

  const healthResponse = await fetch(`${deploymentUrl}/health`);
  if (!healthResponse.ok) {
    throw new Error(
      `Health check failed: ${healthResponse.status} ${await healthResponse.text()}`,
    );
  }

  const samples = Array.from({ length: batchSize }, (_, index) =>
    toNodeWithPortPoints(
      canonicalizeDatasetSample(
        createMatchSampleWithPairCount(8_000_000 + index, pairCount),
      ),
    ),
  );
  const batchRequestBody = encodeBinarySolveBatchRequest(samples).bytes
    .slice()
    .buffer;
  const singleRequestBodies = samples.map(
    (sample) => encodeBinarySolveBatchRequest([sample]).bytes.slice().buffer,
  );

  console.log(
    `Warming ${endpoints.length} endpoints with ${batchSize} pairCount=${pairCount} samples against ${deploymentUrl}`,
  );
  for (const endpoint of endpoints) {
    try {
      await postBinaryJsonEndpoint(deploymentUrl, endpoint, batchRequestBody);
      await runConcurrentSingles(
        deploymentUrl,
        endpoint,
        singleRequestBodies,
        Math.max(...concurrencyLevels),
      );
    } catch (error) {
      console.log(`Warmup failed for ${endpoint}:`, error);
    }
  }

  for (const endpoint of endpoints) {
    const batchWallTimes: number[] = [];
    const concurrentResults = new Map<
      number,
      { wallTimes: number[]; perRequestLatencies: number[]; lastBody: Record<string, unknown> | null }
    >(
      concurrencyLevels.map((concurrency) => [
        concurrency,
        { wallTimes: [], perRequestLatencies: [], lastBody: null },
      ]),
    );
    let lastBatchBody: Record<string, unknown> | null = null;
    let failed = false;
    let failureMessage: string | null = null;

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      try {
        const batchResult = await postBinaryJsonEndpoint(
          deploymentUrl,
          endpoint,
          batchRequestBody,
        );
        batchWallTimes.push(batchResult.elapsedMs);
        lastBatchBody = batchResult.body;

        for (const concurrency of concurrencyLevels) {
          const concurrentResult = await runConcurrentSingles(
            deploymentUrl,
            endpoint,
            singleRequestBodies,
            concurrency,
          );
          const aggregate =
            concurrentResults.get(concurrency) ??
            { wallTimes: [], perRequestLatencies: [], lastBody: null };
          aggregate.wallTimes.push(concurrentResult.wallMs);
          aggregate.perRequestLatencies.push(
            ...concurrentResult.perRequestLatencies,
          );
          aggregate.lastBody = concurrentResult.lastBody;
          concurrentResults.set(concurrency, aggregate);
        }
      } catch (error) {
        failed = true;
        failureMessage = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    console.log(`Endpoint: ${endpoint}`);
    if (failed) {
      console.log("Failed:", failureMessage);
      continue;
    }
    console.log("Single batch wall (ms):", computeStats(batchWallTimes));
    console.log("Last batch response:", lastBatchBody);
    for (const concurrency of concurrencyLevels) {
      const concurrentResult = concurrentResults.get(concurrency);
      if (!concurrentResult) {
        continue;
      }
      console.log(
        `Concurrency ${concurrency} wall (ms):`,
        computeStats(concurrentResult.wallTimes),
      );
      console.log(
        `Concurrency ${concurrency} per-request latency (ms):`,
        computeStats(concurrentResult.perRequestLatencies),
      );
      console.log(
        `Last concurrency ${concurrency} response:`,
        concurrentResult.lastBody,
      );
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
