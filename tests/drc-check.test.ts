import { expect, test } from "bun:test";
import { runDrcCheck } from "../lib/drc-check";
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../lib/types";

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

const createNodeWithPortPoints = (
  portPoints: NodeWithPortPoints["portPoints"],
): NodeWithPortPoints => ({
  capacityMeshNodeId: "sample-drc",
  center: { x: 0, y: 0 },
  width: 4,
  height: 4,
  availableZ: [0, 1],
  portPoints,
});

test("runDrcCheck reports same-layer trace crossings", () => {
  const nodeWithPortPoints = createNodeWithPortPoints([
    { connectionName: "conn00", x: -1, y: 0, z: 0 },
    { connectionName: "conn00", x: 1, y: 0, z: 0 },
    { connectionName: "conn01", x: 0, y: -1, z: 0 },
    { connectionName: "conn01", x: 0, y: 1, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
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
  const nodeWithPortPoints = createNodeWithPortPoints([
    { connectionName: "conn00", x: -1, y: 0, z: 0 },
    { connectionName: "conn00", x: 1, y: 0, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
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
  const nodeWithPortPoints = createNodeWithPortPoints([
    { connectionName: "conn00", x: -1.5, y: -1, z: 0 },
    { connectionName: "conn00", x: -0.5, y: -1, z: 0 },
    { connectionName: "conn01", x: 0.5, y: 1, z: 0 },
    { connectionName: "conn01", x: 1.5, y: 1, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
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

test("runDrcCheck rejects routes that immediately switch layers at an endpoint", () => {
  const nodeWithPortPoints = createNodeWithPortPoints([
    { connectionName: "conn00", x: -1, y: 0, z: 0 },
    { connectionName: "conn00", x: 1, y: 0, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
    createRoute("conn00", [
      { x: -1, y: 0, z: 0 },
      { x: -1, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
    ]),
  ]);

  expect(result.ok).toBe(false);
  expect(
    result.issues.some(
      (issue) =>
        issue.kind === "invalid-route" &&
        issue.message.includes("both port points"),
    ),
  ).toBe(true);
});
