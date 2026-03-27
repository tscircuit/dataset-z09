import { expect, test } from "bun:test";
import type { DatasetSample } from "../lib/types";
import { computeVecRaw } from "../lib/vec-raw";

test("computeVecRaw encodes aspect ratio and ordered port point angles", () => {
  const sample: DatasetSample = {
    capacityMeshNodeId: "sample-test",
    center: { x: 0, y: 0 },
    width: 6,
    height: 3,
    availableZ: [0, 1],
    solvable: true,
    solution: null,
    portPoints: [
      {
        connectionName: "conn00",
        x: 1,
        y: 0,
        z: 0,
      },
      {
        connectionName: "conn00",
        x: 0,
        y: 1,
        z: 1,
      },
      {
        connectionName: "conn01",
        x: -1,
        y: 0,
        z: 0,
      },
      {
        connectionName: "conn01",
        x: 0,
        y: -1,
        z: 1,
      },
    ],
  };

  expect(computeVecRaw(sample)).toEqual([
    2,
    0,
    Math.PI / 2,
    Math.PI,
    -Math.PI / 2,
  ]);
});
