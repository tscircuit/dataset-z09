import { expect, test } from "bun:test";
import type { NodeWithPortPoints } from "../lib/types";
import {
  decodeBinarySolveBatchRequest,
  decodeBinarySolveBatchResponse,
  encodeBinarySolveBatchRequest,
  encodeBinarySolveBatchResponse,
} from "../cf-worker/src/binary";
import type { SolveResponseBody } from "../cf-worker/src/contracts";

test("binary solve-batch request round-trips node geometry and pair order", () => {
  const nodesWithPortPoints: NodeWithPortPoints[] = [
    {
      capacityMeshNodeId: "node-a",
      center: { x: 1.25, y: -0.75 },
      width: 6.5,
      height: 3.25,
      availableZ: [0, 1],
      portPoints: [
        { connectionName: "net-b", x: -2.5, y: 0.5, z: 1 },
        { connectionName: "net-a", x: 2.5, y: -1.5, z: 0 },
        { connectionName: "net-b", x: 2.5, y: 0.5, z: 1 },
        { connectionName: "net-a", x: -2.5, y: -1.5, z: 0 },
      ],
    },
  ];

  const encoded = encodeBinarySolveBatchRequest(nodesWithPortPoints);
  const decoded = decodeBinarySolveBatchRequest(encoded.bytes);

  expect(encoded.connectionNameLists).toEqual([["net-b", "net-a"]]);
  expect(decoded.nodesWithPortPoints).toEqual([
    {
      capacityMeshNodeId: "binary-0",
      center: { x: 1.25, y: -0.75 },
      width: 6.5,
      height: 3.25,
      availableZ: [0, 1],
      portPoints: [
        { connectionName: "conn0", x: -2.5, y: 0.5, z: 1 },
        { connectionName: "conn0", x: 2.5, y: 0.5, z: 1 },
        { connectionName: "conn1", x: 2.5, y: -1.5, z: 0 },
        { connectionName: "conn1", x: -2.5, y: -1.5, z: 0 },
      ],
    },
  ]);
});

test("binary solve-batch response round-trips packed routes and timing header", () => {
  const results: SolveResponseBody[] = [
    {
      ok: true,
      source: "cache",
      pairCount: 2,
      zSignature: "0,1,0,1",
      bucketKey: "2:0,1,0,1",
      bucketSize: 12,
      routes: [
        {
          connectionName: "conn0",
          traceThickness: 0.1,
          viaDiameter: 0.3,
          route: [
            { x: -1.25, y: 0.5, z: 0 },
            { x: 1.25, y: 0.5, z: 0, insideJumperPad: true },
          ],
          vias: [{ x: 0, y: 0.5 }],
        },
      ],
      drc: null,
      timingsMs: {
        total: 1.5,
        kvGet: 1,
        ranking: 0.5,
      },
    },
    {
      ok: true,
      source: "none",
      pairCount: 2,
      zSignature: "0,1,0,1",
      bucketKey: "2:0,1,0,1",
      bucketSize: 12,
      routes: null,
      drc: null,
      timingsMs: {
        total: 2,
      },
      message: "Solver did not find a solution.",
    },
  ];

  const encoded = encodeBinarySolveBatchResponse({
    count: 2,
    uniqueBucketCount: 1,
    results,
    summary: {
      cache: 1,
      solver: 0,
      none: 1,
    },
    timingsMs: {
      total: 12.5,
      requestDecode: 1.25,
      canonicalize: 0.25,
      kvGet: 3.5,
      bucketParse: 0.1,
      ranking: 1.75,
      solve: 0,
      kvWrite: 0,
    },
    traceThickness: 0.1,
    viaDiameter: 0.3,
  });
  const decoded = decodeBinarySolveBatchResponse(encoded, [["net-a"], []]);

  expect(decoded.count).toBe(2);
  expect(decoded.summary).toEqual({
    cache: 1,
    solver: 0,
    none: 1,
  });
  expect(decoded.timingsMs.total).toBe(12.5);
  expect(decoded.timingsMs.requestDecode).toBe(1.25);
  expect(decoded.results).toEqual([
    {
      source: "cache",
      routes: [
        {
          connectionName: "net-a",
          traceThickness: 0.1,
          viaDiameter: 0.3,
          route: [
            { x: -1.25, y: 0.5, z: 0 },
            { x: 1.25, y: 0.5, z: 0, insideJumperPad: true },
          ],
          vias: [{ x: 0, y: 0.5 }],
        },
      ],
    },
    {
      source: "none",
      routes: null,
      message: "Solver did not find a solution.",
    },
  ]);
});
