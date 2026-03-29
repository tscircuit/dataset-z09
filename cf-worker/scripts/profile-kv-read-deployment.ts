const DEFAULT_REPEAT_COUNT = 10;

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

const fetchJson = async (url: string) => {
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers: {
      "cache-control": "no-store",
    },
  });
  const bodyText = await response.text();
  const endedAt = performance.now();

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${bodyText}`);
  }

  return {
    elapsedMs: endedAt - startedAt,
    body: JSON.parse(bodyText) as Record<string, unknown>,
  };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deploymentUrl = requireFlagValue(argv, "--url").replace(/\/$/, "");
  const repeatCount = parseIntegerFlag(
    argv,
    "--repeat-count",
    DEFAULT_REPEAT_COUNT,
  );

  const healthLatencies: number[] = [];
  const kvReadLatencies: number[] = [];
  const kvReadTotals: number[] = [];
  const kvGetTimes: number[] = [];
  let lastKvReadBody: Record<string, unknown> | null = null;

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const healthResult = await fetchJson(`${deploymentUrl}/health`);
    healthLatencies.push(healthResult.elapsedMs);

    const kvReadResult = await fetchJson(`${deploymentUrl}/debug/kv-read`);
    kvReadLatencies.push(kvReadResult.elapsedMs);
    const timingsMs = kvReadResult.body.timingsMs as
      | { total?: number; kvGet?: number }
      | undefined;
    kvReadTotals.push(timingsMs?.total ?? 0);
    kvGetTimes.push(timingsMs?.kvGet ?? 0);
    lastKvReadBody = kvReadResult.body;
  }

  console.log("Health external latency (ms):", computeStats(healthLatencies));
  console.log("KV-read external latency (ms):", computeStats(kvReadLatencies));
  console.log("KV-read worker total (ms):", computeStats(kvReadTotals));
  console.log("KV-read worker kvGet (ms):", computeStats(kvGetTimes));
  console.log("Last KV-read response:", lastKvReadBody);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
