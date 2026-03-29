import { canonicalizeDatasetSample } from "../../lib/solve-cache";
import { createMatchSampleWithPairCount } from "../../lib/match-sample";
import type { NodeWithPortPoints } from "../../lib/types";
import { decodeBinarySolveBatchResponse, encodeBinarySolveBatchRequest } from "../src/binary";

const DEFAULT_PAIR_COUNT = 4;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_REPEAT_COUNT = 5;

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

const toWebSocketUrl = (deploymentUrl: string) =>
  deploymentUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const waitForOpen = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (event: Event | ErrorEvent) => {
      cleanup();
      reject(
        event instanceof ErrorEvent
          ? event.error ?? new Error(event.message)
          : new Error("WebSocket open failed."),
      );
    };
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("error", handleError);
  });

const performWebSocketRoundTrip = (
  socket: WebSocket,
  payload: Uint8Array,
) =>
  new Promise<{ elapsedMs: number; buffer: ArrayBuffer }>((resolve, reject) => {
    const startedAt = performance.now();
    const handleMessage = (event: MessageEvent) => {
      cleanup();
      if (typeof event.data === "string") {
        reject(new Error(`WebSocket server error: ${event.data}`));
        return;
      }

      const endedAt = performance.now();
      const arrayBufferPromise =
        event.data instanceof ArrayBuffer
          ? Promise.resolve(event.data)
          : event.data.arrayBuffer();

      arrayBufferPromise
        .then((arrayBuffer: ArrayBuffer) => {
          resolve({
            elapsedMs: endedAt - startedAt,
            buffer: arrayBuffer,
          });
        })
        .catch(reject);
    };

    const handleError = (event: Event | ErrorEvent) => {
      cleanup();
      reject(
        event instanceof ErrorEvent
          ? event.error ?? new Error(event.message)
          : new Error("WebSocket message failed."),
      );
    };

    const cleanup = () => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
    };

    socket.addEventListener("message", handleMessage, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.send(payload.slice().buffer);
  });

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

  const samples = Array.from({ length: batchSize }, (_, index) =>
    toNodeWithPortPoints(
      canonicalizeDatasetSample(
        createMatchSampleWithPairCount(10_000_000 + index, pairCount),
      ),
    ),
  );
  const encodedRequest = encodeBinarySolveBatchRequest(samples);
  const wsUrl = `${toWebSocketUrl(deploymentUrl)}/ws/solve-batch-binary`;

  const socket = new WebSocket(wsUrl);
  socket.binaryType = "arraybuffer";

  const connectStartedAt = performance.now();
  await waitForOpen(socket);
  const connectEndedAt = performance.now();

  console.log(
    `Opened websocket to ${wsUrl} in ${(connectEndedAt - connectStartedAt).toFixed(2)}ms`,
  );
  console.log(`Warming websocket with one ${batchSize}-node binary batch`);

  const warmupResult = await performWebSocketRoundTrip(socket, encodedRequest.bytes);
  const warmupResponse = decodeBinarySolveBatchResponse(
    warmupResult.buffer,
    encodedRequest.connectionNameLists,
  );
  console.log("Warmup summary:", warmupResponse.summary);

  const latencies: number[] = [];
  const workerTotals: number[] = [];
  const workerRequestDecodeTimes: number[] = [];
  const sourceCounts = new Map<string, number>();

  for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
    const responseResult = await performWebSocketRoundTrip(
      socket,
      encodedRequest.bytes,
    );
    const response = decodeBinarySolveBatchResponse(
      responseResult.buffer,
      encodedRequest.connectionNameLists,
    );

    latencies.push(responseResult.elapsedMs);
    workerTotals.push(response.timingsMs.total);
    workerRequestDecodeTimes.push(response.timingsMs.requestDecode);

    for (const result of response.results) {
      sourceCounts.set(result.source, (sourceCounts.get(result.source) ?? 0) + 1);
    }
  }

  socket.close();

  console.log("Source counts:", Object.fromEntries(sourceCounts.entries()));
  console.log("WebSocket round-trip latency (ms):", computeStats(latencies));
  console.log("Worker total (ms):", computeStats(workerTotals));
  console.log(
    "Worker requestDecode (ms):",
    computeStats(workerRequestDecodeTimes),
  );
  console.log("Request size (bytes):", {
    count: repeatCount,
    avg: encodedRequest.bytes.byteLength,
    min: encodedRequest.bytes.byteLength,
    p50: encodedRequest.bytes.byteLength,
    p95: encodedRequest.bytes.byteLength,
    max: encodedRequest.bytes.byteLength,
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
