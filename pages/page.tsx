import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import { HighDensitySolverA03 } from "@tscircuit/high-density-a01";
import type { BaseSolver } from "@tscircuit/solver-utils";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { useState, useTransition } from "react";
import type { DatasetSample, NodeWithPortPoints } from "../lib/types";

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

const HIGH_DENSITY_A03_PARAMS = {
  highResolutionCellSize: 0.1,
  highResolutionCellThickness: 8,
  lowResolutionCellSize: 0.4,
  traceThickness: 0.1,
  traceMargin: 0.15,
  viaDiameter: 0.3,
  viaMinDistFromBorder: 0.15,
} as const;

type SolverMode = "hyper" | "a03";

const clampIndex = (value: number) =>
  Math.max(0, Math.min(value, datasetSamples.length - 1));

const getNodeWithPortPoints = (sample: DatasetSample): NodeWithPortPoints => ({
  capacityMeshNodeId: sample.capacityMeshNodeId,
  center: sample.center,
  width: sample.width,
  height: sample.height,
  portPoints: sample.portPoints,
  availableZ: sample.availableZ,
});

export default function DatasetPage() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("0");
  const [solverMode, setSolverMode] = useState<SolverMode>("hyper");
  const [isPending, startTransition] = useTransition();
  const firstDatasetEntry = datasetSamples[0];

  if (datasetSamples.length === 0) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background:
            "radial-gradient(circle at top, #f2dcc1 0%, #f9f4ea 48%, #efe6d8 100%)",
          color: "#2f1f15",
          fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
        }}
      >
        No samples generated yet. Run `bun run scripts/generate-samples.ts
        --sample-count 100`.
      </div>
    );
  }

  const currentSample =
    datasetSamples[selectedIndex]?.sample ?? firstDatasetEntry?.sample;
  const currentFileName =
    datasetSamples[selectedIndex]?.fileName ??
    firstDatasetEntry?.fileName ??
    "";

  if (!currentSample) return null;

  const nodeWithPortPoints = getNodeWithPortPoints(currentSample);
  const routeCount = nodeWithPortPoints.portPoints.length / 2;

  const updateSelectedIndex = (nextIndex: number) => {
    const clampedIndex = clampIndex(nextIndex);
    setInputValue(String(clampedIndex));
    startTransition(() => {
      setSelectedIndex(clampedIndex);
    });
  };

  const createDebugSolver = () => {
    if (solverMode === "hyper") {
      const solver = new HyperSingleIntraNodeSolver({
        nodeWithPortPoints,
        effort: 1,
        traceWidth: 0.1,
        viaDiameter: 0.3,
      });

      solver.MAX_ITERATIONS = 1_000_000;
      return solver as unknown as BaseSolver;
    }

    const solver = new HighDensitySolverA03({
      ...HIGH_DENSITY_A03_PARAMS,
      nodeWithPortPoints,
    });

    solver.MAX_ITERATIONS = 2_000_000;
    solver.MAX_RIPS = 2_000;
    solver.setup();
    return solver;
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: 24,
        background:
          "linear-gradient(180deg, #f2dcc1 0%, #f7efe5 38%, #f1ece6 100%)",
        color: "#241913",
        fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          display: "grid",
          gap: 20,
        }}
      >
        <section
          style={{
            borderRadius: 24,
            padding: 24,
            background: "rgba(255, 248, 239, 0.86)",
            boxShadow: "0 24px 60px rgba(71, 45, 26, 0.12)",
            border: "1px solid rgba(86, 55, 32, 0.12)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
            }}
          >
            <div style={{ display: "grid", gap: 10 }}>
              <span
                style={{
                  fontSize: 12,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "#7d5b43",
                }}
              >
                Dataset Z09
              </span>
              <h1
                style={{
                  margin: 0,
                  fontSize: "clamp(28px, 5vw, 48px)",
                  lineHeight: 1,
                }}
              >
                Hyper Intra Node Samples
              </h1>
              <p
                style={{
                  margin: 0,
                  maxWidth: 720,
                  color: "#5f4634",
                  lineHeight: 1.5,
                }}
              >
                Deterministic synthetic nodes for high-density intra-node
                routing, annotated with `solvable` using
                `HyperSingleIntraNodeSolver`. The debugger defaults to that same
                solver so the page matches generation behavior.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "center",
              }}
            >
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

          <div
            style={{
              marginTop: 20,
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            }}
          >
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
              <span>Debugger Solver</span>
              <select
                value={solverMode}
                onChange={(event) =>
                  setSolverMode(event.currentTarget.value as SolverMode)
                }
                style={inputStyle}
              >
                <option value="hyper">HyperSingleIntraNodeSolver</option>
                <option value="a03">HighDensitySolverA03</option>
              </select>
            </label>

            <div style={statCardStyle}>
              <span style={statLabelStyle}>File</span>
              <strong>{currentFileName}</strong>
            </div>

            <div style={statCardStyle}>
              <span style={statLabelStyle}>Routes</span>
              <strong>{routeCount}</strong>
            </div>

            <div style={statCardStyle}>
              <span style={statLabelStyle}>Size</span>
              <strong>
                {currentSample.width.toFixed(2)}mm x{" "}
                {currentSample.height.toFixed(2)}mm
              </strong>
            </div>

            <div style={statCardStyle}>
              <span style={statLabelStyle}>Solvable</span>
              <strong
                style={{
                  color: currentSample.solvable ? "#216c4e" : "#8b342e",
                }}
              >
                {String(currentSample.solvable)}
              </strong>
            </div>
          </div>
        </section>

        <section
          style={{
            borderRadius: 24,
            padding: 16,
            background: "rgba(255, 252, 247, 0.9)",
            boxShadow: "0 18px 50px rgba(71, 45, 26, 0.08)",
            border: "1px solid rgba(86, 55, 32, 0.1)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "0 8px 12px",
              color: "#7d5b43",
              fontSize: 14,
            }}
          >
            {isPending
              ? "Switching sample..."
              : solverMode === "hyper"
                ? "Interactive solver debugger using HyperSingleIntraNodeSolver"
                : "Interactive solver debugger using HighDensitySolverA03"}
          </div>

          <GenericSolverDebugger
            key={`${currentSample.capacityMeshNodeId}-${selectedIndex}-${solverMode}`}
            createSolver={createDebugSolver}
          />
        </section>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid rgba(86, 55, 32, 0.18)",
  background: "#f3e5d2",
  color: "#241913",
  padding: "10px 16px",
  borderRadius: 999,
  cursor: "pointer",
  font: "inherit",
};

const fieldStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  color: "#684c38",
  fontSize: 14,
};

const inputStyle: React.CSSProperties = {
  font: "inherit",
  padding: "12px 14px",
  borderRadius: 14,
  border: "1px solid rgba(86, 55, 32, 0.16)",
  background: "#fffaf2",
  color: "#241913",
};

const statCardStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "12px 14px",
  borderRadius: 16,
  background: "rgba(243, 229, 210, 0.55)",
};

const statLabelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "#8c674d",
};
