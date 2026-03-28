import { expect, test } from "bun:test";
import type { DatasetSample } from "../lib/types";
import { computeVecRaw } from "../lib/vec-raw";

test("computeVecRaw encodes aspect ratio plus topology header and angle/z/x/y for each ordered port point", () => {
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
    0,
    2,
    0,
    0,
    1 / 3,
    0,
    Math.PI / 2,
    1,
    0,
    2 / 3,
    Math.PI,
    0,
    -1 / 3,
    0,
    -Math.PI / 2,
    1,
    0,
    -2 / 3,
  ]);
});

test("computeVecRaw measures angle and normalized x/y relative to the sample center", () => {
  const sample: DatasetSample = {
    capacityMeshNodeId: "sample-offset-center",
    center: { x: 10, y: -5 },
    width: 8,
    height: 4,
    availableZ: [0, 1],
    solvable: false,
    solution: null,
    portPoints: [
      {
        connectionName: "conn00",
        x: 14,
        y: -5,
        z: 0,
      },
      {
        connectionName: "conn00",
        x: 10,
        y: -3,
        z: 1,
      },
    ],
  };

  expect(computeVecRaw(sample)).toEqual([
    2,
    0,
    0,
    1,
    0,
    0,
    1,
    0,
    Math.PI / 2,
    1,
    0,
    1,
  ]);
});

test("computeVecRaw counts same-z and different-z pair intersections in the topology header", () => {
  const sameZCrossingSample: DatasetSample = {
    capacityMeshNodeId: "sample-same-z-crossing",
    center: { x: 0, y: 0 },
    width: 4,
    height: 4,
    availableZ: [0, 1],
    solvable: false,
    solution: null,
    portPoints: [
      { connectionName: "conn00", x: -1, y: 0, z: 0 },
      { connectionName: "conn00", x: 1, y: 0, z: 0 },
      { connectionName: "conn01", x: 0, y: -1, z: 0 },
      { connectionName: "conn01", x: 0, y: 1, z: 0 },
    ],
  };

  const differentZCrossingSample: DatasetSample = {
    ...sameZCrossingSample,
    capacityMeshNodeId: "sample-different-z-crossing",
    portPoints: [
      { connectionName: "conn00", x: -1, y: 0, z: 0 },
      { connectionName: "conn00", x: 1, y: 0, z: 0 },
      { connectionName: "conn01", x: 0, y: -1, z: 1 },
      { connectionName: "conn01", x: 0, y: 1, z: 1 },
    ],
  };

  expect(computeVecRaw(sameZCrossingSample).slice(0, 4)).toEqual([1, 1, 0, 0]);
  expect(computeVecRaw(differentZCrossingSample).slice(0, 4)).toEqual([
    1, 0, 1, 0,
  ]);
});
