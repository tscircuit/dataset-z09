import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { NodeWithPortPoints } from "../../lib/types";
import type {
  SolveBatchResponseBody,
} from "../src/contracts";

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

const postSolveBatchRequest = async (
  deploymentUrl: string,
  nodesWithPortPoints: unknown[],
) => {
  const startedAt = performance.now();
  const response = await fetch(`${deploymentUrl}/solve-batch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      nodesWithPortPoints,
      responseMode: "compact",
    }),
  });
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(
      `Solve batch request failed: ${response.status} ${await response.text()}`,
    );
  }

  return {
    elapsedMs: endedAt - startedAt,
    body: (await response.json()) as SolveBatchResponseBody,
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
        createMatchSampleWithPairCount(2_000_000 + index, pairCount),
      ),
    ),
  );

  console.log(
    `Warming batch of ${batchSize} samples against ${deploymentUrl} for pairCount=${pairCount}`,
  );
  await postSolveBatchRequest(deploymentUrl, samples);

  const externalLatencies: number[] = [];
  const totals: number[] = [];
  const canonicalizeTimes: number[] = [];
  const kvGetTimes: number[] = [];
  const bucketParseTimes: number[] = [];
  const rankingTimes: number[] = [];
  const solveTimes: number[] = [];
  const kvWriteTimes: number[] = [];
  const sourceCounts = new Map<string, number>();

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const result = await postSolveBatchRequest(deploymentUrl, samples);
    externalLatencies.push(result.elapsedMs);
    totals.push(result.body.timingsMs.total);
    canonicalizeTimes.push(result.body.timingsMs.canonicalize);
    kvGetTimes.push(result.body.timingsMs.kvGet);
    bucketParseTimes.push(result.body.timingsMs.bucketParse);
    rankingTimes.push(result.body.timingsMs.ranking);
    solveTimes.push(result.body.timingsMs.solve);
    kvWriteTimes.push(result.body.timingsMs.kvWrite);

    for (const entry of result.body.results) {
      sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + 1);
    }
  }

  console.log("Source counts:", Object.fromEntries(sourceCounts.entries()));
  console.log("External batch latency (ms):", computeStats(externalLatencies));
  console.log("Worker batch total (ms):", computeStats(totals));
  console.log(
    "Worker batch canonicalize (ms):",
    computeStats(canonicalizeTimes),
  );
  console.log("Worker batch kvGet (ms):", computeStats(kvGetTimes));
  console.log(
    "Worker batch bucketParse (ms):",
    computeStats(bucketParseTimes),
  );
  console.log("Worker batch ranking (ms):", computeStats(rankingTimes));
  console.log("Worker batch solve (ms):", computeStats(solveTimes));
  console.log("Worker batch kvWrite (ms):", computeStats(kvWriteTimes));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
