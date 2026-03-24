import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
  PortPoint,
} from "./types";

export const DEFAULT_SAMPLE_COUNT = 100;
export const DEFAULT_DATASET_SEED = 0x5a17_9d09;
export const MIN_ROUTE_COUNT = 1;
export const MAX_ROUTE_COUNT = 12;
export const NODE_SIZE_MIN_MM = 1;
export const NODE_SIZE_MAX_MM = 30;

const AVAILABLE_Z = [0, 1] as const;
const ROOT_CONNECTION_SHARE_PROBABILITY = 0.05;
const SIDES = ["top", "right", "bottom", "left"] as const;

type Side = (typeof SIDES)[number];
type Random = () => number;
type BarePortPoint = Pick<PortPoint, "x" | "y" | "z">;

const OPPOSITE_SIDE: Record<Side, Side> = {
  top: "bottom",
  right: "left",
  bottom: "top",
  left: "right",
};

const ADJACENT_SIDES: Record<Side, Side[]> = {
  top: ["right", "left"],
  right: ["top", "bottom"],
  bottom: ["right", "left"],
  left: ["top", "bottom"],
};

export const roundToTwoDecimals = (value: number) => Number(value.toFixed(2));

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

export const createSampleFileName = (sampleIndex: number) =>
  `sample${sampleIndex.toString().padStart(6, "0")}.json`;

export const getSampleSeed = (
  sampleIndex: number,
  datasetSeed = DEFAULT_DATASET_SEED,
) => (datasetSeed ^ Math.imul(sampleIndex + 1, 0x9e37_79b1)) >>> 0;

export const createDeterministicRandom = (seed: number): Random => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let output = Math.imul(state ^ (state >>> 15), state | 1);
    output ^= output + Math.imul(output ^ (output >>> 7), output | 61);
    return ((output ^ (output >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const randomInt = (random: Random, min: number, max: number) =>
  Math.floor(random() * (max - min + 1)) + min;

const randomFloat = (random: Random, min: number, max: number) =>
  roundToTwoDecimals(min + random() * (max - min));

const pickOne = <T>(random: Random, values: readonly T[]) =>
  values[randomInt(random, 0, values.length - 1)] as T;

const chooseHeightForWidth = (random: Random, width: number) => {
  const minHeight = Math.max(NODE_SIZE_MIN_MM, width / 4);
  const maxHeight = Math.min(NODE_SIZE_MAX_MM, width * 4);
  return randomFloat(random, minHeight, maxHeight);
};

const getAxisPadding = (size: number) =>
  Math.min(Math.max(size * 0.08, 0.08), Math.max(size / 2 - 0.02, 0));

const randomCoordinateOnAxis = (
  random: Random,
  min: number,
  max: number,
): number => {
  if (max <= min) return roundToTwoDecimals((min + max) / 2);
  return randomFloat(random, min, max);
};

const getPerimeterPoint = (
  random: Random,
  side: Side,
  width: number,
  height: number,
): { x: number; y: number } => {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const xPadding = getAxisPadding(width);
  const yPadding = getAxisPadding(height);

  switch (side) {
    case "top":
      return {
        x: randomCoordinateOnAxis(
          random,
          -halfWidth + xPadding,
          halfWidth - xPadding,
        ),
        y: roundToTwoDecimals(halfHeight),
      };
    case "right":
      return {
        x: roundToTwoDecimals(halfWidth),
        y: randomCoordinateOnAxis(
          random,
          -halfHeight + yPadding,
          halfHeight - yPadding,
        ),
      };
    case "bottom":
      return {
        x: randomCoordinateOnAxis(
          random,
          -halfWidth + xPadding,
          halfWidth - xPadding,
        ),
        y: roundToTwoDecimals(-halfHeight),
      };
    case "left":
      return {
        x: roundToTwoDecimals(-halfWidth),
        y: randomCoordinateOnAxis(
          random,
          -halfHeight + yPadding,
          halfHeight - yPadding,
        ),
      };
  }
};

const getEndSide = (random: Random, startSide: Side): Side => {
  const roll = random();

  if (roll < 0.68) return OPPOSITE_SIDE[startSide];
  if (roll < 0.92) return pickOne(random, ADJACENT_SIDES[startSide]);
  return startSide;
};

const distanceBetween = (
  pointA: { x: number; y: number },
  pointB: { x: number; y: number },
) => Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y);

const isPortPointSeparated = (
  point: BarePortPoint,
  existingPortPoints: BarePortPoint[],
  minimumSpacing: number,
) =>
  existingPortPoints.every(
    (existingPoint) =>
      distanceBetween(point, existingPoint) >= minimumSpacing ||
      existingPoint.z !== point.z,
  );

const createPortPointPair = (
  random: Random,
  width: number,
  height: number,
  existingPortPoints: PortPoint[],
): [
  Omit<PortPoint, "connectionName" | "rootConnectionName" | "portPointId">,
  Omit<PortPoint, "connectionName" | "rootConnectionName" | "portPointId">,
] => {
  const minimumSpacing = clamp(
    roundToTwoDecimals(Math.min(width, height) / 5),
    0.12,
    2.5,
  );
  const minimumPairDistance = clamp(
    roundToTwoDecimals(Math.min(width, height) / 2.25),
    0.4,
    6,
  );

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const startSide = pickOne(random, SIDES);
    const endSide = getEndSide(random, startSide);
    const startZ = pickOne(random, AVAILABLE_Z);
    const endZ =
      random() < 0.2
        ? (AVAILABLE_Z.find((zLayer) => zLayer !== startZ) ?? startZ)
        : startZ;
    const start = {
      ...getPerimeterPoint(random, startSide, width, height),
      z: startZ,
    };
    const end = {
      ...getPerimeterPoint(random, endSide, width, height),
      z: endZ,
    };

    if (distanceBetween(start, end) < minimumPairDistance) continue;

    if (
      !isPortPointSeparated(start, existingPortPoints, minimumSpacing) ||
      !isPortPointSeparated(end, [...existingPortPoints, start], minimumSpacing)
    ) {
      continue;
    }

    return [start, end];
  }

  const fallbackStartSide = pickOne(random, SIDES);
  const fallbackEndSide = OPPOSITE_SIDE[fallbackStartSide];

  return [
    {
      ...getPerimeterPoint(random, fallbackStartSide, width, height),
      z: 0,
    },
    {
      ...getPerimeterPoint(random, fallbackEndSide, width, height),
      z: 1,
    },
  ];
};

export const generateNodeWithPortPoints = (
  sampleIndex: number,
  datasetSeed = DEFAULT_DATASET_SEED,
): NodeWithPortPoints => {
  const random = createDeterministicRandom(
    getSampleSeed(sampleIndex, datasetSeed),
  );
  const width = randomFloat(random, NODE_SIZE_MIN_MM, NODE_SIZE_MAX_MM);
  const height = chooseHeightForWidth(random, width);
  const routeCount = randomInt(random, MIN_ROUTE_COUNT, MAX_ROUTE_COUNT);
  const rootConnectionNames: string[] = [];
  const portPoints: PortPoint[] = [];

  for (let routeIndex = 0; routeIndex < routeCount; routeIndex += 1) {
    const connectionName = `conn${routeIndex.toString().padStart(2, "0")}`;
    const rootConnectionName =
      routeIndex > 0 && random() < ROOT_CONNECTION_SHARE_PROBABILITY
        ? pickOne(random, rootConnectionNames)
        : `root${routeIndex.toString().padStart(2, "0")}`;

    rootConnectionNames.push(rootConnectionName);

    const [startPoint, endPoint] = createPortPointPair(
      random,
      width,
      height,
      portPoints,
    );

    portPoints.push(
      {
        connectionName,
        rootConnectionName,
        portPointId: `${connectionName}-a`,
        ...startPoint,
      },
      {
        connectionName,
        rootConnectionName,
        portPointId: `${connectionName}-b`,
        ...endPoint,
      },
    );
  }

  return {
    capacityMeshNodeId: `sample-${sampleIndex.toString().padStart(6, "0")}`,
    center: { x: 0, y: 0 },
    width,
    height,
    availableZ: [...AVAILABLE_Z],
    portPoints,
  };
};

export const createDatasetSample = (
  sampleIndex: number,
  solvable: boolean,
  solution: HighDensityIntraNodeRoute[] | null,
  datasetSeed = DEFAULT_DATASET_SEED,
): DatasetSample => ({
  ...generateNodeWithPortPoints(sampleIndex, datasetSeed),
  solvable,
  solution,
});

export const scaleNodeWithPortPoints = (
  nodeWithPortPoints: NodeWithPortPoints,
  scaleFactor: number,
): NodeWithPortPoints | null => {
  const width = roundToTwoDecimals(nodeWithPortPoints.width * scaleFactor);
  const height = roundToTwoDecimals(nodeWithPortPoints.height * scaleFactor);

  if (
    width < NODE_SIZE_MIN_MM ||
    width > NODE_SIZE_MAX_MM ||
    height < NODE_SIZE_MIN_MM ||
    height > NODE_SIZE_MAX_MM
  ) {
    return null;
  }

  return {
    ...nodeWithPortPoints,
    width,
    height,
    portPoints: nodeWithPortPoints.portPoints.map((portPoint) => ({
      ...portPoint,
      x: roundToTwoDecimals(
        nodeWithPortPoints.center.x +
          (portPoint.x - nodeWithPortPoints.center.x) * scaleFactor,
      ),
      y: roundToTwoDecimals(
        nodeWithPortPoints.center.y +
          (portPoint.y - nodeWithPortPoints.center.y) * scaleFactor,
      ),
    })),
  };
};

const stringifyWithFixedNumbersInternal = (
  value: unknown,
  indentSize: number,
  depth: number,
): string => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toFixed(2) : "null";
  }

  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";

    const childIndent = " ".repeat((depth + 1) * indentSize);
    const currentIndent = " ".repeat(depth * indentSize);

    return `[\n${value
      .map(
        (item) =>
          `${childIndent}${stringifyWithFixedNumbersInternal(
            item,
            indentSize,
            depth + 1,
          )}`,
      )
      .join(",\n")}\n${currentIndent}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);

    if (entries.length === 0) return "{}";

    const childIndent = " ".repeat((depth + 1) * indentSize);
    const currentIndent = " ".repeat(depth * indentSize);

    return `{\n${entries
      .map(
        ([key, childValue]) =>
          `${childIndent}${JSON.stringify(key)}: ${stringifyWithFixedNumbersInternal(
            childValue,
            indentSize,
            depth + 1,
          )}`,
      )
      .join(",\n")}\n${currentIndent}}`;
  }

  return "null";
};

export const stringifyWithFixedNumbers = (value: unknown, indentSize = 2) =>
  stringifyWithFixedNumbersInternal(value, indentSize, 0);
