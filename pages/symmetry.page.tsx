import { getBounds, mergeGraphics, translateGraphics } from "graphics-debug";
import { InteractiveGraphics } from "graphics-debug/react";
import { useState, useTransition } from "react";
import {
  SOLVE_CACHE_SYMMETRIES,
  createSolveCacheEntry,
  getSolveCacheEntrySymmetryVariant,
} from "../lib/solve-cache";
import type { DatasetSample } from "../lib/types";
import {
  clampSampleIndex,
  firstHundredSimplifiedDatasetSampleEntries,
  getSampleRoutes,
} from "./lib/sample-data";
import {
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
} from "./lib/viewer-styles";

const GRID_COLUMNS = 4;
const GRID_COLUMN_GAP = -0.08;
const GRID_ROW_GAP = -0.22;
const LABEL_OFFSET = 0.68;

const mergeAllGraphics = (graphicsObjects: Parameters<typeof mergeGraphics>[0][]) =>
  graphicsObjects.reduce((merged, graphics) => mergeGraphics(merged, graphics), {
    coordinateSystem: "cartesian" as const,
  });

const createSymmetryLabelGraphics = (
  sampleGraphics: ReturnType<typeof sampleToGraphicsObject>,
  symmetry: (typeof SOLVE_CACHE_SYMMETRIES)[number],
) => {
  const bounds = getBounds(sampleGraphics);

  return {
    coordinateSystem: "cartesian" as const,
    texts: [
      {
        x: bounds.minX,
        y: bounds.maxY + LABEL_OFFSET,
        text: symmetry,
        anchorSide: "top_left" as const,
        color: "#3e3026",
        fontSize: 0.22,
        layer: "symmetry-labels",
      },
    ],
  };
};

const createGridGraphics = (sample: DatasetSample) => {
  const solveCacheEntry = createSolveCacheEntry(sample, getSampleRoutes(sample));
  const graphicsBySymmetry = SOLVE_CACHE_SYMMETRIES.map((symmetry) => {
    const symmetryVariant = getSolveCacheEntrySymmetryVariant(
      solveCacheEntry,
      symmetry,
    );
    const displaySample: DatasetSample = {
      ...sample,
      ...symmetryVariant.sample,
      solution: symmetryVariant.solution,
    };
    const sampleGraphics = mergeGraphics(
      sampleToGraphicsObject(displaySample),
      routesToGraphicsObject(displaySample, symmetryVariant.solution),
    );

    return mergeGraphics(
      sampleGraphics,
      createSymmetryLabelGraphics(sampleGraphics, symmetry),
    );
  });

  const measuredGraphics = graphicsBySymmetry.map((graphics) => ({
    graphics,
    bounds: getBounds(graphics),
  }));

  const cellWidth = Math.max(
    ...measuredGraphics.map(({ bounds }) => bounds.maxX - bounds.minX),
  );
  const cellHeight = Math.max(
    ...measuredGraphics.map(({ bounds }) => bounds.maxY - bounds.minY),
  );

  return mergeAllGraphics(
    measuredGraphics.map(({ graphics, bounds }, index) => {
      const column = index % GRID_COLUMNS;
      const row = Math.floor(index / GRID_COLUMNS);
      const dx = column * (cellWidth + GRID_COLUMN_GAP) - bounds.minX;
      const dy = -row * (cellHeight + GRID_ROW_GAP) - bounds.minY;

      return translateGraphics(graphics, dx, dy);
    }),
  );
};

export default function SymmetryPage() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [inputValue, setInputValue] = useState("0");
  const [isPending, startTransition] = useTransition();
  const currentEntry =
    firstHundredSimplifiedDatasetSampleEntries[selectedIndex] ??
    firstHundredSimplifiedDatasetSampleEntries.at(0) ??
    null;

  if (!currentEntry) {
    return (
      <div style={emptyStateStyle}>
        No simplified samples generated yet. Run `bun run simplify:samples`.
      </div>
    );
  }

  const { fileName, sample } = currentEntry;
  const routes = getSampleRoutes(sample);
  const graphics = createGridGraphics(sample);

  const updateSelectedIndex = (nextIndex: number) => {
    const clampedIndex = clampSampleIndex(
      nextIndex,
      firstHundredSimplifiedDatasetSampleEntries.length,
    );
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
              <div style={eyebrowStyle}>Symmetry</div>
              <h1 style={titleStyle}>Simplified Symmetry Grid</h1>
              <p style={descriptionStyle}>
                Each of the first 100 simplified samples can be loaded and
                rendered as a single debug scene containing all 16 solve-cache
                symmetries, including the embedded solution, arranged in a 4x4
                translated grid.
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
                disabled={
                  selectedIndex ===
                  firstHundredSimplifiedDatasetSampleEntries.length - 1
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
                {firstHundredSimplifiedDatasetSampleEntries.map((entry, index) => (
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
                  : `${SOLVE_CACHE_SYMMETRIES.length} symmetry variants`}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Routes</span>
              <strong>{routes.length}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Port Points</span>
              <strong>{sample.portPoints.length}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Sample File</span>
              <strong>{fileName}</strong>
            </article>
          </div>
        </section>

        <section style={viewerCardStyle}>
          <InteractiveGraphics graphics={graphics} height={1280} />
        </section>
      </div>
    </div>
  );
}
