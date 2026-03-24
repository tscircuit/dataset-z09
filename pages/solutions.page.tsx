import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import type { HighDensityIntraNodeRoute } from "@tscircuit/high-density-a01";
import type { GraphicsObject } from "graphics-debug";
import { mergeGraphics } from "graphics-debug";
import { InteractiveGraphics } from "graphics-debug/react";
import { useState, useTransition } from "react";
import type { DatasetSample, PortPoint } from "../lib/types";

const sampleModules = import.meta.glob<DatasetSample>("../samples/*.json", {
  eager: true,
  import: "default",
});

const datasetSamples = Object.entries(sampleModules)
  .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
  .map(([path, sample]) => ({
    fileName: path.split("/").at(-1) ?? path,
    sample,
  }));

const sampleRenderCache = new Map<string, SampleRenderData>();

type SampleRenderData = {
  graphics: GraphicsObject;
  solvedRoutes: HighDensityIntraNodeRoute[];
  solverError: string | null;
  failed: boolean;
  iterations: number;
};

const clampIndex = (value: number) =>
  Math.max(0, Math.min(value, datasetSamples.length - 1));

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

const groupPortPointsByConnection = (portPoints: PortPoint[]) => {
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

const getConnectionColorMap = (sample: DatasetSample) => {
  const connectionNames = [...groupPortPointsByConnection(sample.portPoints).keys()];

  return new Map(
    connectionNames.map((connectionName, index) => [
      connectionName,
      palette[index % palette.length],
    ]),
  );
};

const getLayerFill = (z: number) => (z === 0 ? "#fff2cc" : "#dceeff");

const sampleToGraphicsObject = (sample: DatasetSample): GraphicsObject => {
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

const routesToGraphicsObject = (
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
        strokeColor: color,
        strokeWidth: route.traceThickness,
        strokeDash: current.z === 0 ? undefined : [0.14, 0.08],
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

const getSampleRenderData = (
  fileName: string,
  sample: DatasetSample,
): SampleRenderData => {
  const cached = sampleRenderCache.get(fileName);
  if (cached) return cached;

  const solver = new HyperSingleIntraNodeSolver({
    nodeWithPortPoints: {
      capacityMeshNodeId: sample.capacityMeshNodeId,
      center: sample.center,
      width: sample.width,
      height: sample.height,
      portPoints: sample.portPoints,
      availableZ: sample.availableZ,
    },
    effort: 1,
    traceWidth: 0.1,
    viaDiameter: 0.3,
  });

  solver.MAX_ITERATIONS = 1_000_000;

  let solvedRoutes: HighDensityIntraNodeRoute[] = [];

  try {
    solver.solve();
    solvedRoutes = solver.solvedRoutes;
  } catch {
    solvedRoutes = [];
  }

  const data: SampleRenderData = {
    graphics: mergeGraphics(
      sampleToGraphicsObject(sample),
      routesToGraphicsObject(sample, solvedRoutes),
    ),
    solvedRoutes,
    solverError: solver.error,
    failed: solver.failed,
    iterations: solver.iterations,
  };

  sampleRenderCache.set(fileName, data);
  return data;
};

export default function DatasetFixturePage() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("0");
  const [isPending, startTransition] = useTransition();
  const currentEntry =
    datasetSamples[selectedIndex] ?? datasetSamples.at(0) ?? null;

  if (!currentEntry) {
    return (
      <div style={emptyStateStyle}>
        No samples generated yet. Run `bun run generate:samples`.
      </div>
    );
  }

  const { fileName, sample } = currentEntry;
  const renderData = getSampleRenderData(fileName, sample);

  const updateSelectedIndex = (nextIndex: number) => {
    const clampedIndex = clampIndex(nextIndex);
    setInputValue(String(clampedIndex));
    startTransition(() => {
      setSelectedIndex(clampedIndex);
    });
  };

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div style={heroHeaderStyle}>
            <div>
              <div style={eyebrowStyle}>Fixture</div>
              <h1 style={titleStyle}>Sample Graphics Viewer</h1>
              <p style={descriptionStyle}>
                Each dataset sample is converted into a `GraphicsObject`, then
                merged with solved routes from `HyperSingleIntraNodeSolver` and
                rendered with `graphics-debug/react`.
              </p>
            </div>

            <div style={controlsRowStyle}>
              <button
                type="button"
                onClick={() => updateSelectedIndex(selectedIndex - 1)}
                disabled={selectedIndex === 0}
                style={buttonStyle}
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => updateSelectedIndex(selectedIndex + 1)}
                disabled={selectedIndex === datasetSamples.length - 1}
                style={buttonStyle}
              >
                Next
              </button>
            </div>
          </div>

          <div style={metaGridStyle}>
            <label style={fieldStyle}>
              <span>Sample Number</span>
              <input
                inputMode="numeric"
                value={inputValue}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value.replace(
                    /[^\d]/g,
                    "",
                  );
                  setInputValue(nextValue);

                  if (nextValue === "") return;
                  updateSelectedIndex(Number.parseInt(nextValue, 10));
                }}
                onBlur={() => {
                  if (inputValue === "") {
                    updateSelectedIndex(selectedIndex);
                    return;
                  }

                  updateSelectedIndex(Number.parseInt(inputValue, 10));
                }}
                style={inputStyle}
              />
            </label>

            <label style={fieldStyle}>
              <span>Sample File</span>
              <select
                value={selectedIndex}
                onChange={(event) =>
                  updateSelectedIndex(Number.parseInt(event.currentTarget.value, 10))
                }
                style={inputStyle}
              >
                {datasetSamples.map((entry, index) => (
                  <option key={entry.fileName} value={index}>
                    {entry.fileName}
                  </option>
                ))}
              </select>
            </label>

            <article style={statCardStyle}>
              <span>Status</span>
              <strong>
                {isPending
                  ? "Loading sample..."
                  : renderData.failed
                    ? "Solver failed"
                    : `${renderData.solvedRoutes.length} routes solved`}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Dataset Label</span>
              <strong>{sample.solvable ? "Solvable" : "Unsolvable"}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Port Points</span>
              <strong>{sample.portPoints.length}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Iterations</span>
              <strong>{renderData.iterations.toLocaleString()}</strong>
            </article>
          </div>

          {renderData.solverError ? (
            <p style={errorStyle}>Solver error: {renderData.solverError}</p>
          ) : null}
        </section>

        <section style={viewerCardStyle}>
          <InteractiveGraphics graphics={renderData.graphics} height={760} />
        </section>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  padding: 24,
  background:
    "linear-gradient(180deg, #f4efe8 0%, #efe7dc 42%, #e4ddd4 100%)",
  color: "#1f2933",
  fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
};

const shellStyle: React.CSSProperties = {
  maxWidth: 1380,
  margin: "0 auto",
  display: "grid",
  gap: 18,
};

const heroStyle: React.CSSProperties = {
  borderRadius: 24,
  padding: 24,
  background: "rgba(255, 251, 245, 0.92)",
  border: "1px solid rgba(52, 73, 94, 0.12)",
  boxShadow: "0 24px 60px rgba(66, 52, 35, 0.12)",
};

const heroHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "flex-start",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "#7c5c45",
  marginBottom: 10,
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(30px, 5vw, 52px)",
  lineHeight: 0.95,
};

const descriptionStyle: React.CSSProperties = {
  margin: "12px 0 0",
  maxWidth: 780,
  color: "#5d4d40",
  lineHeight: 1.55,
};

const controlsRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};

const metaGridStyle: React.CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
};

const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
  fontSize: 13,
  color: "#6b5a4a",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid rgba(76, 96, 119, 0.24)",
  padding: "12px 14px",
  background: "#fffdf9",
  color: "#1f2933",
  fontSize: 15,
};

const buttonStyle: React.CSSProperties = {
  borderRadius: 999,
  border: "1px solid rgba(76, 96, 119, 0.2)",
  background: "#fffaf2",
  color: "#1f2933",
  padding: "10px 16px",
  fontSize: 14,
  cursor: "pointer",
};

const statCardStyle: React.CSSProperties = {
  display: "grid",
  gap: 8,
  alignContent: "start",
  padding: 16,
  borderRadius: 18,
  background: "rgba(245, 239, 232, 0.9)",
  border: "1px solid rgba(76, 96, 119, 0.14)",
  color: "#6b5a4a",
};

const viewerCardStyle: React.CSSProperties = {
  borderRadius: 24,
  overflow: "hidden",
  background: "rgba(255, 252, 247, 0.96)",
  border: "1px solid rgba(52, 73, 94, 0.12)",
  boxShadow: "0 24px 60px rgba(66, 52, 35, 0.12)",
};

const errorStyle: React.CSSProperties = {
  margin: "16px 0 0",
  color: "#a61e4d",
};

const emptyStateStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background:
    "radial-gradient(circle at top, #f2dcc1 0%, #f9f4ea 48%, #efe6d8 100%)",
  color: "#2f1f15",
  fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
};
