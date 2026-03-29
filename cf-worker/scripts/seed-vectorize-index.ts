import { join } from "node:path";
import { parseSolveCacheFile } from "../../lib/solve-cache";
import { expandEntryIntoWorkerBuckets } from "../src/cache-logic";
import type {
  UpsertVectorizeEntriesRequestBody,
  WorkerBucketEntry,
} from "../src/contracts";

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

const postVectorizeChunk = async (
  deploymentUrl: string,
  adminToken: string,
  payload: UpsertVectorizeEntriesRequestBody,
) => {
  const response = await fetch(`${deploymentUrl}/admin/upsert-vectorize-entries`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upsert vectorize entries for pairCount=${payload.pointPairCount}: ${response.status} ${await response.text()}`,
    );
  }
};

const loadSolveCacheEntries = async (pairCount: number) => {
  const cachePath = join(process.cwd(), `solve-cache-${pairCount}.json`);
  const rawCache = await Bun.file(cachePath).text();
  return parseSolveCacheFile(JSON.parse(rawCache), pairCount).entries;
};

const dedupeEntries = (entries: WorkerBucketEntry[]) => {
  const entriesById = new Map<string, WorkerBucketEntry>();

  for (const entry of entries) {
    entriesById.set(entry.entryId, entry);
  }

  return [...entriesById.values()];
};

const main = async () => {
  const argv = process.argv.slice(2);
  const deploymentUrl = requireFlagValue(argv, "--url").replace(/\/$/, "");
  const adminToken = requireFlagValue(argv, "--admin-token");
  const pairCount = parseIntegerFlag(argv, "--pair-count", 4);
  const chunkSize = parseIntegerFlag(argv, "--chunk-size", DEFAULT_CHUNK_SIZE);

  const entries = await loadSolveCacheEntries(pairCount);
  const expandedEntries = dedupeEntries(
    entries.flatMap((entry) => expandEntryIntoWorkerBuckets(entry)),
  );
  const entryChunks = chunkEntries(expandedEntries, chunkSize);

  console.log(
    `Seeding Vectorize pairCount=${pairCount} with ${expandedEntries.length} symmetry variants in ${entryChunks.length} chunks`,
  );

  for (let chunkIndex = 0; chunkIndex < entryChunks.length; chunkIndex += 1) {
    const chunk = entryChunks[chunkIndex] ?? [];
    await postVectorizeChunk(deploymentUrl, adminToken, {
      pointPairCount: pairCount,
      entries: chunk,
    });
    console.log(
      `Uploaded vectorize chunk ${chunkIndex + 1}/${entryChunks.length} (${chunk.length} entries)`,
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
