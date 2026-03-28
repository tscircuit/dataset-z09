import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { NodeWithPortPoints } from "../../lib/types";
import type { SolveBatchResponseBody } from "../src/contracts";
import {
  decodeBinarySolveBatchResponse,
  encodeBinarySolveBatchRequest,
} from "../src/binary";

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

const postJsonSolveBatchRequest = async (
  deploymentUrl: string,
  nodesWithPortPoints: NodeWithPortPoints[],
) => {
  const requestBody = JSON.stringify({
    nodesWithPortPoints,
    responseMode: "compact",
  });
  const requestBytes = new TextEncoder().encode(requestBody).length;
  const startedAt = performance.now();
  const response = await fetch(`${deploymentUrl}/solve-batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: requestBody,
  });
  const bodyText = await response.text();
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(
      `JSON solve batch request failed: ${response.status} ${bodyText}`,
    );
  }

  return {
    elapsedMs: endedAt - startedAt,
    requestBytes,
    responseBytes: new TextEncoder().encode(bodyText).length,
    body: JSON.parse(bodyText) as SolveBatchResponseBody,
  };
};

const postBinarySolveBatchRequest = async (
  deploymentUrl: string,
  nodesWithPortPoints: NodeWithPortPoints[],
) => {
  const encodedRequest = encodeBinarySolveBatchRequest(nodesWithPortPoints);
  const requestBody = encodedRequest.bytes.slice().buffer;
  const startedAt = performance.now();
  const response = await fetch(`${deploymentUrl}/solve-batch-binary`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
    },
    body: requestBody,
  });
  const bodyBuffer = await response.arrayBuffer();
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(
      `Binary solve batch request failed: ${response.status} ${new TextDecoder().decode(bodyBuffer)}`,
    );
  }

  return {
    elapsedMs: endedAt - startedAt,
    requestBytes: requestBody.byteLength,
    responseBytes: bodyBuffer.byteLength,
    body: decodeBinarySolveBatchResponse(
      bodyBuffer,
      encodedRequest.connectionNameLists,
    ),
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
        createMatchSampleWithPairCount(6_000_000 + index, pairCount),
      ),
    ),
  );

  console.log(
    `Warming JSON and binary batch endpoints with ${batchSize} samples against ${deploymentUrl} for pairCount=${pairCount}`,
  );
  await postJsonSolveBatchRequest(deploymentUrl, samples);
  await postBinarySolveBatchRequest(deploymentUrl, samples);

  const modes = [
    {
      label: "json-compact",
      run: () => postJsonSolveBatchRequest(deploymentUrl, samples),
    },
    {
      label: "binary",
      run: () => postBinarySolveBatchRequest(deploymentUrl, samples),
    },
  ] as const;

  for (const mode of modes) {
    const externalLatencies: number[] = [];
    const requestSizes: number[] = [];
    const responseSizes: number[] = [];
    const totals: number[] = [];
    const requestDecodeTimes: number[] = [];
    const kvGetTimes: number[] = [];
    const sourceCounts = new Map<string, number>();

    for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
      const result = await mode.run();
      externalLatencies.push(result.elapsedMs);
      requestSizes.push(result.requestBytes);
      responseSizes.push(result.responseBytes);
      totals.push(result.body.timingsMs.total);
      requestDecodeTimes.push(result.body.timingsMs.requestDecode);
      kvGetTimes.push(result.body.timingsMs.kvGet);

      for (const entry of result.body.results) {
        sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + 1);
      }
    }

    console.log(`Mode: ${mode.label}`);
    console.log("Source counts:", Object.fromEntries(sourceCounts.entries()));
    console.log("External latency (ms):", computeStats(externalLatencies));
    console.log("Request size (bytes):", computeStats(requestSizes));
    console.log("Response size (bytes):", computeStats(responseSizes));
    console.log("Worker total (ms):", computeStats(totals));
    console.log("Worker requestDecode (ms):", computeStats(requestDecodeTimes));
    console.log("Worker kvGet (ms):", computeStats(kvGetTimes));
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
