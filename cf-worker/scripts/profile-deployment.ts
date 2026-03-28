import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { SolveResponseBody } from "../src/contracts";

const DEFAULT_PAIR_COUNT = 4;
const DEFAULT_SAMPLE_COUNT = 32;
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

const postSolveRequest = async (
  deploymentUrl: string,
  nodeWithPortPoints: unknown,
) => {
  const startedAt = performance.now();
  const response = await fetch(`${deploymentUrl}/solve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      nodeWithPortPoints,
    }),
  });
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(
      `Solve request failed: ${response.status} ${await response.text()}`,
    );
  }

  return {
    elapsedMs: endedAt - startedAt,
    body: (await response.json()) as SolveResponseBody,
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deploymentUrl = requireFlagValue(argv, "--url").replace(/\/$/, "");
  const pairCount = parseIntegerFlag(argv, "--pair-count", DEFAULT_PAIR_COUNT);
  const sampleCount = parseIntegerFlag(
    argv,
    "--sample-count",
    DEFAULT_SAMPLE_COUNT,
  );
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

  const samples = Array.from({ length: sampleCount }, (_, index) =>
    canonicalizeDatasetSample(
      createMatchSampleWithPairCount(1_000_000 + index, pairCount),
    ),
  );

  console.log(
    `Warming ${sampleCount} samples against ${deploymentUrl} for pairCount=${pairCount}`,
  );

  for (const sample of samples) {
    await postSolveRequest(deploymentUrl, sample);
  }

  const externalLatencies: number[] = [];
  const internalTotals: number[] = [];
  const kvReads: number[] = [];
  const rankings: number[] = [];
  const hitSources = new Map<string, number>();
  let successCount = 0;

  console.log(`Profiling ${sampleCount * repeatCount} cache-hit requests`);

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    for (const sample of samples) {
      const result = await postSolveRequest(deploymentUrl, sample);
      externalLatencies.push(result.elapsedMs);
      internalTotals.push(result.body.timingsMs.total);

      if (result.body.timingsMs.kvRead !== undefined) {
        kvReads.push(result.body.timingsMs.kvRead);
      }
      if (result.body.timingsMs.ranking !== undefined) {
        rankings.push(result.body.timingsMs.ranking);
      }

      hitSources.set(
        result.body.source,
        (hitSources.get(result.body.source) ?? 0) + 1,
      );

      if (result.body.source === "cache") {
        successCount += 1;
      }
    }
  }

  console.log("Source counts:", Object.fromEntries(hitSources.entries()));
  console.log(`Cache hits during profile: ${successCount}/${sampleCount * repeatCount}`);
  console.log("External latency (ms):", computeStats(externalLatencies));
  console.log("Worker total timing (ms):", computeStats(internalTotals));
  console.log("Worker KV read timing (ms):", computeStats(kvReads));
  console.log("Worker ranking timing (ms):", computeStats(rankings));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
