import type { GraphicsObject } from "graphics-debug";
import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
  PortPoint,
} from "../../lib/types";

const palette = [
  "#d1495b",
  "#00798c",
  "#edae49",
  "#30638e",
  "#5c4d7d",
  "#3d5a40",
  "#ef476f",
  "#118ab2",
  "#8f2d56",
  "#6c757d",
];

const withAlpha = (hexColor: string, alphaHex: string) =>
  `${hexColor}${alphaHex}`;

export const groupPortPointsByConnection = (portPoints: PortPoint[]) => {
  const grouped = new Map<string, PortPoint[]>();

  for (const portPoint of portPoints) {
    const existing = grouped.get(portPoint.connectionName);
    if (existing) {
      existing.push(portPoint);
    } else {
      grouped.set(portPoint.connectionName, [portPoint]);
    }
  }

  return grouped;
};

export const getConnectionColorMap = (sample: DatasetSample) => {
  const connectionNames = [
    ...groupPortPointsByConnection(sample.portPoints).keys(),
  ];

  return new Map(
    connectionNames.map((connectionName, index) => [
      connectionName,
      palette[index % palette.length],
    ]),
  );
};

const getLayerFill = (z: number) => (z === 0 ? "#fff2cc" : "#dceeff");

export const sampleToGraphicsObject = (sample: DatasetSample): GraphicsObject => {
  const colorMap = getConnectionColorMap(sample);
  const groupedConnections = groupPortPointsByConnection(sample.portPoints);
  const minX = sample.center.x - sample.width / 2;
  const maxX = sample.center.x + sample.width / 2;
  const minY = sample.center.y - sample.height / 2;
  const maxY = sample.center.y + sample.height / 2;

  return {
    coordinateSystem: "cartesian",
    title: sample.capacityMeshNodeId,
    lines: [...groupedConnections.entries()]
      .filter(([, points]) => points.length === 2)
      .map(([connectionName, points]) => ({
        points: points.map(({ x, y }) => ({ x, y })),
        strokeColor: `${colorMap.get(connectionName) ?? "#6c757d"}55`,
        strokeWidth: 0.04,
        strokeDash: [0.08, 0.08],
        label: `${connectionName} endpoints`,
        layer: "endpoint-guides",
      })),
    circles: sample.portPoints.map((portPoint) => ({
      center: { x: portPoint.x, y: portPoint.y },
      radius: 0.08,
      fill: getLayerFill(portPoint.z),
      stroke: colorMap.get(portPoint.connectionName) ?? "#6c757d",
      label: `${portPoint.connectionName} (${portPoint.portPointId ?? "port"}, z${portPoint.z})`,
      layer: `ports-z${portPoint.z}`,
    })),
    texts: [
      {
        x: minX,
        y: maxY + 0.18,
        text: "z0: solid route segments",
        anchorSide: "top_left",
        color: "#495057",
        fontSize: 0.16,
        layer: "legend",
      },
      {
        x: minX,
        y: maxY + 0.34,
        text: "z1+: dashed route segments",
        anchorSide: "top_left",
        color: "#495057",
        fontSize: 0.16,
        layer: "legend",
      },
      {
        x: maxX,
        y: minY - 0.18,
        text: sample.solvable ? "dataset: solvable" : "dataset: unsolvable",
        anchorSide: "bottom_right",
        color: sample.solvable ? "#2d6a4f" : "#b02a37",
        fontSize: 0.18,
        layer: "legend",
      },
    ],
  };
};

export const routesToGraphicsObject = (
  sample: DatasetSample,
  routes: HighDensityIntraNodeRoute[],
): GraphicsObject => {
  const colorMap = getConnectionColorMap(sample);
  const lines: NonNullable<GraphicsObject["lines"]> = [];
  const circles: NonNullable<GraphicsObject["circles"]> = [];

  for (const route of routes) {
    const color = colorMap.get(route.connectionName) ?? "#6c757d";

    for (let index = 0; index < route.route.length - 1; index += 1) {
      const current = route.route[index];
      const next = route.route[index + 1];
      if (!current || !next) continue;

      if (current.z !== next.z) continue;
      if (current.x === next.x && current.y === next.y) continue;

      lines.push({
        points: [
          { x: current.x, y: current.y },
          { x: next.x, y: next.y },
        ],
        strokeColor: current.z === 1 ? withAlpha(color, "80") : color,
        strokeWidth: route.traceThickness,
        strokeDash: current.z === 1 ? [0.4, 0.2] : undefined,
        label: `${route.connectionName} z${current.z}`,
        layer: `route-z${current.z}`,
      });
    }

    for (const via of route.vias) {
      circles.push({
        center: { x: via.x, y: via.y },
        radius: route.viaDiameter / 2,
        fill: "#ffffff",
        stroke: color,
        label: `${route.connectionName} via`,
        layer: "vias",
      });
    }
  }

  return {
    coordinateSystem: "cartesian",
    title: "Solved routes",
    lines,
    circles,
  };
};

export const getTraceSegmentCount = (route: HighDensityIntraNodeRoute) => {
  let count = 0;

  for (let index = 0; index < route.route.length - 1; index += 1) {
    const current = route.route[index];
    const next = route.route[index + 1];
    if (!current || !next) continue;

    if (current.z !== next.z) continue;
    if (current.x === next.x && current.y === next.y) continue;

    count += 1;
  }

  return count;
};

export const getTotalTraceSegmentCount = (
  routes: HighDensityIntraNodeRoute[],
) => routes.reduce((total, route) => total + getTraceSegmentCount(route), 0);
