import { expect, test } from "bun:test";
import { runDrcCheck } from "../lib/drc-check";
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../lib/types";

const baseNodeWithPortPoints: NodeWithPortPoints = {
  capacityMeshNodeId: "sample-drc",
  center: { x: 0, y: 0 },
  width: 4,
  height: 4,
  availableZ: [0, 1],
  portPoints: [],
};

const createRoute = (
  connectionName: string,
  route: HighDensityIntraNodeRoute["route"],
  vias: HighDensityIntraNodeRoute["vias"] = [],
): HighDensityIntraNodeRoute => ({
  connectionName,
  traceThickness: 0.1,
  viaDiameter: 0.3,
  route,
  vias,
});

test("runDrcCheck reports same-layer trace crossings", () => {
  const result = runDrcCheck(baseNodeWithPortPoints, [
    createRoute("conn00", [
      { x: -1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    createRoute("conn01", [
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 1, z: 0 },
    ]),
  ]);

  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.kind === "trace-trace")).toBe(
    true,
  );
});

test("runDrcCheck reports via overlaps with traces", () => {
  const result = runDrcCheck(baseNodeWithPortPoints, [
    createRoute(
      "conn00",
      [
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ],
      [{ x: 0, y: 0.05 }],
    ),
  ]);

  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.kind === "via-trace")).toBe(true);
});

test("runDrcCheck accepts separated routes", () => {
  const result = runDrcCheck(baseNodeWithPortPoints, [
    createRoute("conn00", [
      { x: -1.5, y: -1, z: 0 },
      { x: -0.5, y: -1, z: 0 },
    ]),
    createRoute("conn01", [
      { x: 0.5, y: 1, z: 0 },
      { x: 1.5, y: 1, z: 0 },
    ]),
  ]);

  expect(result.ok).toBe(true);
  expect(result.issues).toHaveLength(0);
});
