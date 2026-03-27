import { mergeGraphics } from "graphics-debug";
import { InteractiveGraphics } from "graphics-debug/react";
import { useEffect, useState, useTransition } from "react";
import { runForceDirectedImprovement } from "../lib/force-improve";
import { simplifyRoutes } from "../lib/simplify";
import {
  clampSampleIndex,
  firstHundredDatasetSampleEntries,
  getSampleRoutes,
} from "./lib/sample-data";
import {
  forceVectorsToGraphicsObject,
  getTotalTraceSegmentCount,
  routesToGraphicsObject,
  sampleToGraphicsObject,
} from "./lib/sample-graphics";
import {
  buttonStyle,
  controlsRowStyle,
  descriptionStyle,
  emptyStateStyle,
  eyebrowStyle,
  fieldStyle,
  heroHeaderStyle,
  heroStyle,
  inputStyle,
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

export default function SimplifierPage() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("0");
  const [isPending, startTransition] = useTransition();
  const currentEntry =
    firstHundredDatasetSampleEntries[selectedIndex] ??
    firstHundredDatasetSampleEntries.at(0) ??
    null;

  if (!currentEntry) {
    return (
      <div style={emptyStateStyle}>
        No samples generated yet. Run `bun run generate:samples`.
      </div>
    );
  }

  const { fileName, sample } = currentEntry;
  const originalRoutes = getSampleRoutes(sample);
  const baseSimplifiedRoutes = simplifyRoutes(originalRoutes);
  const [improvedRoutes, setImprovedRoutes] = useState(baseSimplifiedRoutes);
  const [forceVectors, setForceVectors] = useState<
    ReturnType<typeof runForceDirectedImprovement>["forceVectors"]
  >([]);
  const [simulationSteps, setSimulationSteps] = useState(0);

  useEffect(() => {
    setImprovedRoutes(baseSimplifiedRoutes);
    setForceVectors([]);
    setSimulationSteps(0);
  }, [fileName]);

  const beforeGraphics = mergeGraphics(
    sampleToGraphicsObject(sample),
    routesToGraphicsObject(sample, originalRoutes),
  );
  const afterGraphics = mergeGraphics(
    mergeGraphics(
      sampleToGraphicsObject(sample),
      routesToGraphicsObject(sample, improvedRoutes),
    ),
    forceVectorsToGraphicsObject(forceVectors),
  );

  const originalSegmentCount = getTotalTraceSegmentCount(originalRoutes);
  const improvedSegmentCount = getTotalTraceSegmentCount(improvedRoutes);
  const originalViaCount = originalRoutes.reduce(
    (total, route) => total + route.vias.length,
    0,
  );
  const improvedViaCount = improvedRoutes.reduce(
    (total, route) => total + route.vias.length,
    0,
  );

  const updateSelectedIndex = (nextIndex: number) => {
    const clampedIndex = clampSampleIndex(
      nextIndex,
      firstHundredDatasetSampleEntries.length,
    );
    setInputValue(String(clampedIndex));
    startTransition(() => {
      setSelectedIndex(clampedIndex);
    });
  };

  const runSimulation = (totalSteps: number) => {
    const result = runForceDirectedImprovement(sample, improvedRoutes, totalSteps);
    setImprovedRoutes(result.routes);
    setForceVectors(result.forceVectors);
    setSimulationSteps((currentSteps) => currentSteps + result.stepsCompleted);
  };

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div style={heroHeaderStyle}>
            <div>
              <div style={eyebrowStyle}>Simplifier</div>
              <h1 style={titleStyle}>Trace Simplification Viewer</h1>
              <p style={descriptionStyle}>
                The first 100 samples are rendered twice: once with the embedded
                routes, and once after every route is simplified down to 10
                trace segments, then iteratively improved by a force-directed
                pass.
              </p>
            </div>

            <div style={controlsRowStyle}>
              <button
                type="button"
                onClick={() => runSimulation(1)}
                style={buttonStyle}
              >
                Step
              </button>
              <button
                type="button"
                onClick={() => runSimulation(100)}
                style={buttonStyle}
              >
                Play
              </button>
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
                disabled={
                  selectedIndex === firstHundredDatasetSampleEntries.length - 1
                }
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
                  updateSelectedIndex(
                    Number.parseInt(event.currentTarget.value, 10),
                  )
                }
                style={inputStyle}
              >
                {firstHundredDatasetSampleEntries.map((entry, index) => (
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
                  : `${originalRoutes.length} routes, ${simulationSteps} force steps`}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Segments</span>
              <strong>
                {originalSegmentCount} before / {improvedSegmentCount} after
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Vias</span>
              <strong>
                {originalViaCount} before / {improvedViaCount} after
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Force Vectors</span>
              <strong>{forceVectors.length}</strong>
            </article>
          </div>
        </section>

        <section style={viewerGridStyle}>
          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <h2 style={viewerPanelTitleStyle}>Before</h2>
              <span>Embedded routes from the dataset sample.</span>
            </div>
            <InteractiveGraphics graphics={beforeGraphics} height={640} />
          </article>

          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <h2 style={viewerPanelTitleStyle}>After</h2>
              <span>{fileName} with force vectors shown in magenta.</span>
            </div>
            <InteractiveGraphics graphics={afterGraphics} height={640} />
          </article>
        </section>
      </div>
    </div>
  );
}
