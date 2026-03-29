import type { HighDensityIntraNodeRoute, NodeWithPortPoints } from "../../lib/types";
import type { SolveResponseBody } from "./contracts";

const REQUEST_MAGIC = "DZB1";
const RESPONSE_MAGIC = "DZS3";
const COORDINATE_SCALE = 100;
const ROUTING_SCALE = 1_000;
const REQUEST_HEADER_SIZE = 8;
const RESPONSE_HEADER_SIZE = 52;

type DecodedBinarySolveBatchRequest = {
  nodesWithPortPoints: NodeWithPortPoints[];
};

type EncodedBinarySolveBatchRequest = {
  bytes: Uint8Array;
  connectionNameLists: string[][];
};

type BinarySolveBatchResponsePayload = {
  count: number;
  uniqueBucketCount: number;
  results: SolveResponseBody[];
  summary: {
    cache: number;
    solver: number;
    none: number;
  };
  timingsMs: {
    total: number;
    requestDecode: number;
    canonicalize: number;
    kvGet: number;
    bucketParse: number;
    ranking: number;
    solve: number;
    kvWrite: number;
  };
  traceThickness: number;
  viaDiameter: number;
};

type DecodedBinarySolveBatchResponse = {
  count: number;
  uniqueBucketCount: number;
  summary: {
    cache: number;
    solver: number;
    none: number;
  };
  timingsMs: {
    total: number;
    requestDecode: number;
    canonicalize: number;
    kvGet: number;
    bucketParse: number;
    ranking: number;
    solve: number;
    kvWrite: number;
  };
  traceThickness: number;
  viaDiameter: number;
  results: Array<{
    source: "cache" | "solver" | "none";
    routes: HighDensityIntraNodeRoute[] | null;
    message?: string;
  }>;
};

class BinaryWriter {
  private readonly buffer: Uint8Array;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
  }

  writeMagic(value: string) {
    if (value.length !== 4) {
      throw new Error(`Magic must be 4 ASCII chars, received "${value}".`);
    }

    for (let index = 0; index < value.length; index += 1) {
      this.writeUint8(value.charCodeAt(index));
    }
  }

  writeUint8(value: number) {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  writeUint16(value: number) {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeUint32(value: number) {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  writeInt16(value: number) {
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  finish() {
    return this.buffer;
  }
}

class BinaryReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(buffer: ArrayBuffer | Uint8Array) {
    const viewBuffer = buffer instanceof Uint8Array ? buffer.buffer : buffer;
    const byteOffset = buffer instanceof Uint8Array ? buffer.byteOffset : 0;
    const byteLength = buffer instanceof Uint8Array ? buffer.byteLength : buffer.byteLength;
    this.view = new DataView(viewBuffer, byteOffset, byteLength);
  }

  readMagic() {
    let value = "";
    for (let index = 0; index < 4; index += 1) {
      value += String.fromCharCode(this.readUint8());
    }
    return value;
  }

  readUint8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt16() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  get isAtEnd() {
    return this.offset === this.view.byteLength;
  }
}

const quantizeSigned = (value: number, scale: number) => {
  const quantized = Math.round(value * scale);
  if (quantized < -32_768 || quantized > 32_767) {
    throw new Error(`Value ${value} is out of int16 range after quantization.`);
  }
  return quantized;
};

const quantizeUnsigned = (value: number, scale: number) => {
  const quantized = Math.round(value * scale);
  if (quantized < 0 || quantized > 65_535) {
    throw new Error(`Value ${value} is out of uint16 range after quantization.`);
  }
  return quantized;
};

const quantizeTiming = (valueMs: number) => {
  const quantized = Math.round(valueMs * 1_000);
  if (quantized < 0 || quantized > 0xffff_ffff) {
    throw new Error(`Timing ${valueMs}ms is out of uint32 range after quantization.`);
  }
  return quantized;
};

const dequantize = (value: number, scale: number) => value / scale;

const getConnectionPairs = (nodeWithPortPoints: NodeWithPortPoints) => {
  const pointsByConnection = new Map<string, typeof nodeWithPortPoints.portPoints>();

  for (const portPoint of nodeWithPortPoints.portPoints) {
    const connectionPoints = pointsByConnection.get(portPoint.connectionName) ?? [];
    connectionPoints.push(portPoint);
    pointsByConnection.set(portPoint.connectionName, connectionPoints);
  }

  return [...pointsByConnection.entries()].map(([connectionName, portPoints]) => {
    if (portPoints.length !== 2) {
      throw new Error(
        `Connection "${connectionName}" must have exactly 2 port points for binary encoding.`,
      );
    }

    return {
      connectionName,
      portPoints,
    };
  });
};

const getRequestSize = (nodesWithPortPoints: NodeWithPortPoints[]) =>
  REQUEST_HEADER_SIZE +
  nodesWithPortPoints.reduce((totalSize, nodeWithPortPoints) => {
    const connectionPairs = getConnectionPairs(nodeWithPortPoints);
    const availableZCount = nodeWithPortPoints.availableZ?.length ?? 0;
    return totalSize + 10 + availableZCount + connectionPairs.length * 10;
  }, 0);

const getResponseSize = (payload: BinarySolveBatchResponsePayload) =>
  RESPONSE_HEADER_SIZE +
  payload.results.reduce((totalSize, result) => {
    if (!result.routes) {
      return totalSize + 4;
    }

    return (
      totalSize +
      4 +
      result.routes.reduce((routeTotalSize, route) => {
        if (route.jumpers && route.jumpers.length > 0) {
          throw new Error("Binary solve-batch responses do not support jumpers.");
        }

        return (
          routeTotalSize +
          10 +
          route.route.length * 6 +
          route.vias.length * 4
        );
      }, 0)
    );
  }, 0);

export const encodeBinarySolveBatchRequest = (
  nodesWithPortPoints: NodeWithPortPoints[],
): EncodedBinarySolveBatchRequest => {
  const writer = new BinaryWriter(getRequestSize(nodesWithPortPoints));
  const connectionNameLists: string[][] = [];

  writer.writeMagic(REQUEST_MAGIC);
  writer.writeUint16(nodesWithPortPoints.length);
  writer.writeUint16(0);

  for (const nodeWithPortPoints of nodesWithPortPoints) {
    const connectionPairs = getConnectionPairs(nodeWithPortPoints);
    const availableZ = nodeWithPortPoints.availableZ ?? [];

    if (connectionPairs.length > 255) {
      throw new Error("Binary solve-batch requests support at most 255 point pairs per node.");
    }

    if (availableZ.length > 255) {
      throw new Error("Binary solve-batch requests support at most 255 available-z values.");
    }

    writer.writeInt16(quantizeSigned(nodeWithPortPoints.center.x, COORDINATE_SCALE));
    writer.writeInt16(quantizeSigned(nodeWithPortPoints.center.y, COORDINATE_SCALE));
    writer.writeUint16(quantizeUnsigned(nodeWithPortPoints.width, COORDINATE_SCALE));
    writer.writeUint16(quantizeUnsigned(nodeWithPortPoints.height, COORDINATE_SCALE));
    writer.writeUint8(connectionPairs.length);
    writer.writeUint8(availableZ.length);

    for (const z of availableZ) {
      writer.writeUint8(z);
    }

    for (const pair of connectionPairs) {
      for (const portPoint of pair.portPoints) {
        writer.writeInt16(quantizeSigned(portPoint.x, COORDINATE_SCALE));
        writer.writeInt16(quantizeSigned(portPoint.y, COORDINATE_SCALE));
        writer.writeUint8(portPoint.z);
      }
    }

    connectionNameLists.push(connectionPairs.map((pair) => pair.connectionName));
  }

  return {
    bytes: writer.finish(),
    connectionNameLists,
  };
};

export const decodeBinarySolveBatchRequest = (
  buffer: ArrayBuffer | Uint8Array,
): DecodedBinarySolveBatchRequest => {
  const reader = new BinaryReader(buffer);
  const magic = reader.readMagic();

  if (magic !== REQUEST_MAGIC) {
    throw new Error(`Invalid solve-batch binary request magic: ${magic}`);
  }

  const nodeCount = reader.readUint16();
  reader.readUint16();

  const nodesWithPortPoints: NodeWithPortPoints[] = [];

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    const centerX = dequantize(reader.readInt16(), COORDINATE_SCALE);
    const centerY = dequantize(reader.readInt16(), COORDINATE_SCALE);
    const width = dequantize(reader.readUint16(), COORDINATE_SCALE);
    const height = dequantize(reader.readUint16(), COORDINATE_SCALE);
    const pairCount = reader.readUint8();
    const availableZCount = reader.readUint8();
    const availableZ = Array.from({ length: availableZCount }, () => reader.readUint8());
    const portPoints: NodeWithPortPoints["portPoints"] = [];

    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const connectionName = `conn${pairIndex}`;

      for (let pointIndex = 0; pointIndex < 2; pointIndex += 1) {
        portPoints.push({
          connectionName,
          x: dequantize(reader.readInt16(), COORDINATE_SCALE),
          y: dequantize(reader.readInt16(), COORDINATE_SCALE),
          z: reader.readUint8(),
        });
      }
    }

    nodesWithPortPoints.push({
      capacityMeshNodeId: `binary-${nodeIndex}`,
      center: { x: centerX, y: centerY },
      width,
      height,
      portPoints,
      ...(availableZ.length > 0 ? { availableZ } : {}),
    });
  }

  if (!reader.isAtEnd) {
    throw new Error("Trailing bytes found at end of solve-batch binary request.");
  }

  return {
    nodesWithPortPoints,
  };
};

const getSourceCode = (source: SolveResponseBody["source"]) => {
  if (source === "cache") return 1;
  if (source === "solver") return 2;
  return 0;
};

const getMessageCode = (message: string | undefined) => {
  if (!message) return 0;
  if (message === "Solver did not find a solution.") return 1;
  if (message === "Solver produced routes, but they failed validation.") return 2;
  return 255;
};

const getMessageFromCode = (messageCode: number) => {
  if (messageCode === 1) return "Solver did not find a solution.";
  if (messageCode === 2) return "Solver produced routes, but they failed validation.";
  return undefined;
};

const getConnectionIndex = (connectionName: string) => {
  const match = /^conn(\d+)$/.exec(connectionName);
  if (!match) {
    throw new Error(
      `Binary solve-batch responses require synthetic connN names, received "${connectionName}".`,
    );
  }

  return Number.parseInt(match[1] ?? "", 10);
};

export const encodeBinarySolveBatchResponse = (
  payload: BinarySolveBatchResponsePayload,
): Uint8Array => {
  const writer = new BinaryWriter(getResponseSize(payload));
  const quantizedTraceThickness = quantizeUnsigned(
    payload.traceThickness,
    ROUTING_SCALE,
  );
  const quantizedViaDiameter = quantizeUnsigned(
    payload.viaDiameter,
    ROUTING_SCALE,
  );

  writer.writeMagic(RESPONSE_MAGIC);
  writer.writeUint16(payload.count);
  writer.writeUint16(payload.uniqueBucketCount);
  writer.writeUint16(payload.summary.cache);
  writer.writeUint16(payload.summary.solver);
  writer.writeUint16(payload.summary.none);
  writer.writeUint16(quantizedTraceThickness);
  writer.writeUint16(quantizedViaDiameter);
  writer.writeUint16(0);
  writer.writeUint32(quantizeTiming(payload.timingsMs.total));
  writer.writeUint32(quantizeTiming(payload.timingsMs.requestDecode));
  writer.writeUint32(quantizeTiming(payload.timingsMs.canonicalize));
  writer.writeUint32(quantizeTiming(payload.timingsMs.kvGet));
  writer.writeUint32(quantizeTiming(payload.timingsMs.bucketParse));
  writer.writeUint32(quantizeTiming(payload.timingsMs.ranking));
  writer.writeUint32(quantizeTiming(payload.timingsMs.solve));
  writer.writeUint32(quantizeTiming(payload.timingsMs.kvWrite));

  for (const result of payload.results) {
    const routes = result.routes ?? [];

    writer.writeUint8(getSourceCode(result.source));
    writer.writeUint8(getMessageCode(result.message));
    writer.writeUint8(routes.length);
    writer.writeUint8(0);

    for (const route of routes) {
      writer.writeUint8(getConnectionIndex(route.connectionName));
      writer.writeUint8(0);
      writer.writeUint16(quantizeUnsigned(route.traceThickness, ROUTING_SCALE));
      writer.writeUint16(quantizeUnsigned(route.viaDiameter, ROUTING_SCALE));
      writer.writeUint16(route.route.length);
      writer.writeUint16(route.vias.length);

      for (const routePoint of route.route) {
        writer.writeInt16(quantizeSigned(routePoint.x, COORDINATE_SCALE));
        writer.writeInt16(quantizeSigned(routePoint.y, COORDINATE_SCALE));
        writer.writeUint8(routePoint.z);
        writer.writeUint8(routePoint.insideJumperPad ? 1 : 0);
      }

      for (const via of route.vias) {
        writer.writeInt16(quantizeSigned(via.x, COORDINATE_SCALE));
        writer.writeInt16(quantizeSigned(via.y, COORDINATE_SCALE));
      }
    }
  }

  return writer.finish();
};

export const decodeBinarySolveBatchResponse = (
  buffer: ArrayBuffer | Uint8Array,
  connectionNameLists?: string[][],
): DecodedBinarySolveBatchResponse => {
  const reader = new BinaryReader(buffer);
  const magic = reader.readMagic();

  if (magic !== RESPONSE_MAGIC) {
    throw new Error(`Invalid solve-batch binary response magic: ${magic}`);
  }

  const count = reader.readUint16();
  const uniqueBucketCount = reader.readUint16();
  const summary = {
    cache: reader.readUint16(),
    solver: reader.readUint16(),
    none: reader.readUint16(),
  };
  const traceThickness = dequantize(reader.readUint16(), ROUTING_SCALE);
  const viaDiameter = dequantize(reader.readUint16(), ROUTING_SCALE);
  reader.readUint16();

  const timingsMs = {
    total: dequantize(reader.readUint32(), 1_000),
    requestDecode: dequantize(reader.readUint32(), 1_000),
    canonicalize: dequantize(reader.readUint32(), 1_000),
    kvGet: dequantize(reader.readUint32(), 1_000),
    bucketParse: dequantize(reader.readUint32(), 1_000),
    ranking: dequantize(reader.readUint32(), 1_000),
    solve: dequantize(reader.readUint32(), 1_000),
    kvWrite: dequantize(reader.readUint32(), 1_000),
  };

  const results: DecodedBinarySolveBatchResponse["results"] = [];

  for (let nodeIndex = 0; nodeIndex < count; nodeIndex += 1) {
    const sourceCode = reader.readUint8();
    const messageCode = reader.readUint8();
    const routeCount = reader.readUint8();
    reader.readUint8();

    const source =
      sourceCode === 1 ? "cache" : sourceCode === 2 ? "solver" : "none";
    const connectionNames =
      connectionNameLists?.[nodeIndex] ??
      Array.from({ length: routeCount }, (_, index) => `conn${index}`);
    const routes: HighDensityIntraNodeRoute[] = [];

    for (let routeIndex = 0; routeIndex < routeCount; routeIndex += 1) {
      const connectionIndex = reader.readUint8();
      reader.readUint8();
      const traceThickness = dequantize(reader.readUint16(), ROUTING_SCALE);
      const viaDiameter = dequantize(reader.readUint16(), ROUTING_SCALE);
      const pointCount = reader.readUint16();
      const viaCount = reader.readUint16();
      const routePoints: HighDensityIntraNodeRoute["route"] = [];
      const vias: HighDensityIntraNodeRoute["vias"] = [];

      for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        routePoints.push({
          x: dequantize(reader.readInt16(), COORDINATE_SCALE),
          y: dequantize(reader.readInt16(), COORDINATE_SCALE),
          z: reader.readUint8(),
          ...(reader.readUint8() === 1 ? { insideJumperPad: true } : {}),
        });
      }

      for (let viaIndex = 0; viaIndex < viaCount; viaIndex += 1) {
        vias.push({
          x: dequantize(reader.readInt16(), COORDINATE_SCALE),
          y: dequantize(reader.readInt16(), COORDINATE_SCALE),
        });
      }

      routes.push({
        connectionName: connectionNames[connectionIndex] ?? `conn${connectionIndex}`,
        traceThickness,
        viaDiameter,
        route: routePoints,
        vias,
      });
    }

    results.push({
      source,
      routes: routes.length > 0 ? routes : null,
      ...(getMessageFromCode(messageCode) ? { message: getMessageFromCode(messageCode) } : {}),
    });
  }

  if (!reader.isAtEnd) {
    throw new Error("Trailing bytes found at end of solve-batch binary response.");
  }

  return {
    count,
    uniqueBucketCount,
    summary,
    timingsMs,
    traceThickness,
    viaDiameter,
    results,
  };
};
