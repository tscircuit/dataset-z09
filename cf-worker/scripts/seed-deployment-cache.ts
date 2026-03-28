import { join } from "node:path";
import { parseSolveCacheFile, type SolveCacheEntry } from "../../lib/solve-cache";
import { getNodePointPairCount } from "../../lib/solve-cache";
import {
  expandEntryIntoWorkerBuckets,
  getBucketKey,
  groupBucketEntriesByKey,
} from "../src/cache-logic";
import type { UpsertBucketRequestBody, WorkerBucketEntry } from "../src/contracts";

const DEFAULT_CHUNK_SIZE = 200;

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

const chunkEntries = <T>(entries: T[], chunkSize: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < entries.length; index += chunkSize) {
    chunks.push(entries.slice(index, index + chunkSize));
  }

  return chunks;
};

const postBucketChunk = async (
  deploymentUrl: string,
  adminToken: string,
  payload: UpsertBucketRequestBody,
) => {
  const response = await fetch(`${deploymentUrl}/admin/upsert-bucket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upsert ${payload.pointPairCount}:${payload.zSignature}: ${response.status} ${await response.text()}`,
    );
  }
};

const loadSolveCacheEntries = async (pairCount: number) => {
  const cachePath = join(process.cwd(), `solve-cache-${pairCount}.json`);
  const rawCache = await Bun.file(cachePath).text();
  return parseSolveCacheFile(JSON.parse(rawCache), pairCount).entries;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deploymentUrl = requireFlagValue(argv, "--url").replace(/\/$/, "");
  const adminToken = requireFlagValue(argv, "--admin-token");
  const pairCount = parseIntegerFlag(argv, "--pair-count", 4);
  const chunkSize = parseIntegerFlag(argv, "--chunk-size", DEFAULT_CHUNK_SIZE);

  const entries = await loadSolveCacheEntries(pairCount);
  const expandedEntries = entries.flatMap((entry) =>
    expandEntryIntoWorkerBuckets(entry),
  );
  const entriesByBucketKey = groupBucketEntriesByKey(expandedEntries);

  console.log(
    `Seeding ${entries.length} entries (${expandedEntries.length} symmetry variants) into ${entriesByBucketKey.size} buckets for pairCount=${pairCount}`,
  );

  let uploadedChunkCount = 0;

  for (const [bucketKey, bucketEntries] of entriesByBucketKey.entries()) {
    const [rawPointPairCount, zSignature] = bucketKey.split(":");
    const pointPairCount = Number.parseInt(rawPointPairCount ?? "", 10);
    const entryChunks = chunkEntries(bucketEntries, chunkSize);

    for (let chunkIndex = 0; chunkIndex < entryChunks.length; chunkIndex += 1) {
      const chunk = entryChunks[chunkIndex] ?? [];
      await postBucketChunk(deploymentUrl, adminToken, {
        pointPairCount,
        zSignature: zSignature ?? "",
        entries: chunk,
      });
      uploadedChunkCount += 1;
      console.log(
        `Uploaded bucket ${bucketKey} chunk ${chunkIndex + 1}/${entryChunks.length} (${chunk.length} entries) totalChunks=${uploadedChunkCount}`,
      );
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
