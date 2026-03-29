import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { NodeWithPortPoints } from "../../lib/types";
import { encodeBinarySolveBatchRequest } from "../src/binary";

const DEFAULT_PAIR_COUNT = 4;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_REPEAT_COUNT = 3;

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

  const healthResponse = await fetch(`${deploymentUrl}/health`);
  if (!healthResponse.ok) {
    throw new Error(
      `Health check failed: ${healthResponse.status} ${await healthResponse.text()}`,
    );
  }

  const samples = Array.from({ length: batchSize }, (_, index) =>
    toNodeWithPortPoints(
      canonicalizeDatasetSample(
        createMatchSampleWithPairCount(7_000_000 + index, pairCount),
      ),
    ),
  );
  const encodedRequest = encodeBinarySolveBatchRequest(samples);
  const requestBody = encodedRequest.bytes.slice().buffer;

  const endpoints = [
    "/debug/stage/match-binary",
    "/debug/stage/vectorize-query-binary",
    "/debug/stage/vectorize-fetch-binary",
    "/debug/stage/vectorize-match-binary",
  ] as const;

  console.log(
    `Warming ${endpoints.length} endpoints with ${batchSize} pairCount=${pairCount} samples against ${deploymentUrl}`,
  );
  for (const endpoint of endpoints) {
    await postBinaryJsonEndpoint(deploymentUrl, endpoint, requestBody);
  }

  for (const endpoint of endpoints) {
    const externalLatencies: number[] = [];
    let lastBody: Record<string, unknown> | null = null;

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      const result = await postBinaryJsonEndpoint(
        deploymentUrl,
        endpoint,
        requestBody,
      );
      externalLatencies.push(result.elapsedMs);
      lastBody = result.body;
    }

    console.log(`Endpoint: ${endpoint}`);
    console.log("External latency (ms):", computeStats(externalLatencies));
    console.log("Last response:", lastBody);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
