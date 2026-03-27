import { HyperSingleIntraNodeSolver } from "@tscircuit/capacity-autorouter";
import type { BaseSolver } from "@tscircuit/solver-utils";
import { GenericSolverDebugger } from "@tscircuit/solver-utils/react";
import { mergeGraphics } from "graphics-debug";
import { InteractiveGraphics } from "graphics-debug/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMatchSampleWithPairCount,
  resizeSampleToDimensions,
} from "../lib/match-sample";
import type { DatasetSample, NodeWithPortPoints } from "../lib/types";
import { computeVecRaw } from "../lib/vec-raw";
import {
  routesToGraphicsObject,
  sampleToGraphicsObject,
} from "./lib/sample-graphics";
import {
  buttonStyle,
  descriptionStyle,
  eyebrowStyle,
  heroHeaderStyle,
  heroStyle,
  metaGridStyle,
  pageStyle,
  shellStyle,
  statCardStyle,
  titleStyle,
  viewerCardStyle,
  viewerGridStyle,
  viewerPanelHeaderStyle,
  viewerPanelTitleStyle,
} from "./lib/viewer-styles";

type NearestNeighborResponse = {
  fileName: string;
  distance: number;
  sample: DatasetSample;
};

const DEFAULT_PAIR_COUNT = 4;
const MIN_PAIR_COUNT = 1;
const MAX_PAIR_COUNT = 6;

const createRandomMatchSample = (pairCount: number) => {
  const sampleIndex = 1_000_000 + Math.floor(Math.random() * 9_000_000);
  return createMatchSampleWithPairCount(sampleIndex, pairCount);
};

const getNodeWithPortPoints = (sample: DatasetSample): NodeWithPortPoints => ({
  capacityMeshNodeId: sample.capacityMeshNodeId,
  center: sample.center,
  width: sample.width,
  height: sample.height,
  portPoints: sample.portPoints,
  availableZ: sample.availableZ,
});

export default function MatchPage() {
  const [pairCount, setPairCount] = useState(DEFAULT_PAIR_COUNT);
  const [generatedSample, setGeneratedSample] = useState<DatasetSample>(() => {
    const sample = createRandomMatchSample(DEFAULT_PAIR_COUNT);
    return {
      ...sample,
      vecRaw: computeVecRaw(sample),
    };
  });
  const [nearestNeighbor, setNearestNeighbor] =
    useState<NearestNeighborResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRunInitialLookupRef = useRef(false);

  const lookupNearestNeighbor = useCallback(async (sample: DatasetSample) => {
    const rawVec = sample.vecRaw ?? computeVecRaw(sample);

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/get_nearest_neighbor", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rawVec }),
      });

      const payload = (await response.json()) as
        | NearestNeighborResponse
        | { error: string };

      if (!response.ok || "error" in payload) {
        throw new Error(
          "error" in payload
            ? payload.error
            : `Nearest-neighbor lookup failed with status ${response.status}`,
        );
      }

      setNearestNeighbor(payload);
    } catch (lookupError) {
      setError(
        lookupError instanceof Error
          ? lookupError.message
          : String(lookupError),
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshMatch = (nextPairCount = pairCount) => {
    const nextSample = createRandomMatchSample(nextPairCount);
    const nextGeneratedSample: DatasetSample = {
      ...nextSample,
      vecRaw: computeVecRaw(nextSample),
    };

    setGeneratedSample(nextGeneratedSample);
    setNearestNeighbor(null);
    void lookupNearestNeighbor(nextGeneratedSample);
  };

  useEffect(() => {
    if (hasRunInitialLookupRef.current) {
      return;
    }

    hasRunInitialLookupRef.current = true;
    void lookupNearestNeighbor(generatedSample);
  }, [generatedSample, lookupNearestNeighbor]);

  const nearestSample = nearestNeighbor?.sample ?? null;
  const nearestGraphics = nearestSample
    ? mergeGraphics(
        sampleToGraphicsObject(nearestSample),
        routesToGraphicsObject(nearestSample, nearestSample.solution ?? []),
      )
    : null;
  const resizedGeneratedSample = nearestSample
    ? resizeSampleToDimensions(
        generatedSample,
        nearestSample.width,
        nearestSample.height,
      )
    : generatedSample;
  const generatedNodeWithPortPoints = getNodeWithPortPoints(
    resizedGeneratedSample,
  );

  const createDebugSolver = () => {
    const solver = new HyperSingleIntraNodeSolver({
      nodeWithPortPoints: generatedNodeWithPortPoints,
      effort: 1,
      traceWidth: 0.1,
      viaDiameter: 0.3,
    });

    solver.MAX_ITERATIONS = 1_000_000;
    return solver as unknown as BaseSolver;
  };

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div style={heroHeaderStyle}>
            <div>
              <div style={eyebrowStyle}>Matcher</div>
              <h1 style={titleStyle}>Nearest Neighbor Match</h1>
              <p style={descriptionStyle}>
                This page generates a deliberately out-of-band routing problem,
                canonicalizes its raw vector, and asks the Vite API to return
                the closest simplified sample by vector distance.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                void refreshMatch();
              }}
              style={buttonStyle}
            >
              Generate Another
            </button>
          </div>

          <div style={metaGridStyle}>
            <label style={statCardStyle}>
              <span>Pairs</span>
              <select
                value={pairCount}
                onChange={(event) => {
                  const nextPairCount = Number.parseInt(
                    event.currentTarget.value,
                    10,
                  );
                  setPairCount(nextPairCount);
                  void refreshMatch(nextPairCount);
                }}
                style={{
                  borderRadius: 12,
                  border: "1px solid rgba(76, 96, 119, 0.24)",
                  padding: "10px 12px",
                  background: "#fffdf9",
                  color: "#1f2933",
                  font: "inherit",
                }}
              >
                {Array.from(
                  { length: MAX_PAIR_COUNT - MIN_PAIR_COUNT + 1 },
                  (_, index) => {
                    const value = MIN_PAIR_COUNT + index;
                    return (
                      <option key={value} value={value}>
                        {value} pair{value === 1 ? "" : "s"}
                      </option>
                    );
                  },
                )}
              </select>
            </label>

            <article style={statCardStyle}>
              <span>Generated Sample</span>
              <strong>{generatedSample.capacityMeshNodeId}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Aspect Ratio</span>
              <strong>
                {resizedGeneratedSample.width.toFixed(2)} :{" "}
                {resizedGeneratedSample.height.toFixed(2)}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>rawVec Length</span>
              <strong>
                {generatedSample.vecRaw?.length ?? 0} ({pairCount} pairs)
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Lookup Status</span>
              <strong>
                {isLoading
                  ? "Searching..."
                  : error
                    ? "Failed"
                    : nearestNeighbor
                      ? "Matched"
                      : "Idle"}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Closest Sample</span>
              <strong>{nearestNeighbor?.fileName ?? "Pending"}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Vector Distance</span>
              <strong>
                {nearestNeighbor
                  ? nearestNeighbor.distance.toFixed(4)
                  : "Pending"}
              </strong>
            </article>
          </div>

          {error ? (
            <p style={{ ...descriptionStyle, color: "#b02a37" }}>{error}</p>
          ) : null}
        </section>

        <section style={viewerGridStyle}>
          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <h2 style={viewerPanelTitleStyle}>Generated Problem</h2>
              <span>
                Interactive solver debugger for the generated nearest-neighbor
                query problem.
              </span>
            </div>
            <div style={{ padding: "0 20px 20px", color: "#6b5a4a" }}>
              HyperSingleIntraNodeSolver on{" "}
              {resizedGeneratedSample.capacityMeshNodeId} resized to match{" "}
              {nearestNeighbor?.fileName ?? "pending match"}
            </div>
            <GenericSolverDebugger
              key={`${generatedSample.capacityMeshNodeId}-${nearestNeighbor?.fileName ?? "pending"}`}
              createSolver={createDebugSolver}
            />
          </article>

          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <h2 style={viewerPanelTitleStyle}>Retrieved Sample</h2>
              <span>
                {nearestNeighbor
                  ? `${nearestNeighbor.fileName} with its simplified routes`
                  : "Waiting for nearest-neighbor lookup"}
              </span>
            </div>
            {nearestGraphics ? (
              <InteractiveGraphics graphics={nearestGraphics} height={640} />
            ) : (
              <div
                style={{
                  minHeight: 640,
                  display: "grid",
                  placeItems: "center",
                  color: "#6b5a4a",
                }}
              >
                {isLoading ? "Searching nearest sample..." : "No match yet"}
              </div>
            )}
          </article>
        </section>
      </div>
    </div>
  );
}
