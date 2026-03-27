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
  rootConnectionName?: string,
): HighDensityIntraNodeRoute => ({
  connectionName,
  rootConnectionName,
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
    { connectionName: "conn01", x: 0.3, y: -1.5, z: 0 },
    { connectionName: "conn01", x: 0.3, y: 1.5, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
    createRoute("conn00", [
      { x: -1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]),
    createRoute(
      "conn01",
      [
        { x: 0.3, y: -1.5, z: 0 },
        { x: 0.3, y: 1.5, z: 0 },
      ],
      [{ x: 0, y: 0.05 }],
    ),
  ]);

  expect(result.ok).toBe(false);
  expect(result.issues.some((issue) => issue.kind === "via-trace")).toBe(true);
});

test("runDrcCheck ignores trace crossings on the same root net", () => {
  const nodeWithPortPoints = createNodeWithPortPoints([
    {
      connectionName: "conn00",
      rootConnectionName: "root00",
      x: -1,
      y: 0,
      z: 0,
    },
    {
      connectionName: "conn00",
      rootConnectionName: "root00",
      x: 1,
      y: 0,
      z: 0,
    },
    {
      connectionName: "conn01",
      rootConnectionName: "root00",
      x: 0,
      y: -1,
      z: 0,
    },
    {
      connectionName: "conn01",
      rootConnectionName: "root00",
      x: 0,
      y: 1,
      z: 0,
    },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
    createRoute(
      "conn00",
      [
        { x: -1, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
      ],
      [],
      "root00",
    ),
    createRoute(
      "conn01",
      [
        { x: 0, y: -1, z: 0 },
        { x: 0, y: 1, z: 0 },
      ],
      [],
      "root00",
    ),
  ]);

  expect(result.ok).toBe(true);
  expect(result.issues).toHaveLength(0);
});

test("runDrcCheck accepts boundary endpoints without out-of-bounds issues", () => {
  const nodeWithPortPoints = createNodeWithPortPoints([
    { connectionName: "conn00", x: -2, y: 0, z: 0 },
    { connectionName: "conn00", x: 2, y: 0, z: 0 },
  ]);

  const result = runDrcCheck(nodeWithPortPoints, [
    createRoute("conn00", [
      { x: -2, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ]),
  ]);

  expect(result.ok).toBe(true);
  expect(result.issues.some((issue) => issue.kind === "out-of-bounds")).toBe(
    false,
  );
});

test("runDrcCheck accepts perimeter points after width rounding to two decimals", () => {
  const nodeWithPortPoints: NodeWithPortPoints = {
    capacityMeshNodeId: "sample-drc-rounded-bounds",
    center: { x: 0, y: 0 },
    width: 12.99,
    height: 51.96,
    availableZ: [0, 1],
    portPoints: [
      { connectionName: "conn00", x: 0.74, y: 25.98, z: 1 },
      { connectionName: "conn00", x: -6.5, y: -11.48, z: 1 },
    ],
  };

  const result = runDrcCheck(nodeWithPortPoints, [
    createRoute("conn00", [
      { x: 0.74, y: 25.98, z: 1 },
      { x: -6.5, y: -11.48, z: 1 },
    ]),
  ]);

  expect(result.ok).toBe(true);
  expect(result.issues.some((issue) => issue.kind === "out-of-bounds")).toBe(
    false,
  );
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
