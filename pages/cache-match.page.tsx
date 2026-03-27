import { mergeGraphics } from "graphics-debug";
import { InteractiveGraphics } from "graphics-debug/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMatchSampleWithPairCount } from "../lib/match-sample";
import {
  type DihedralSymmetry,
  canonicalizeDatasetSample,
} from "../lib/solve-cache";
import type { DatasetSample, HighDensityIntraNodeRoute } from "../lib/types";
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

type CacheMatchResponse = {
  entryIndex: number;
  distance: number;
  symmetry: DihedralSymmetry;
  cacheSample: DatasetSample;
  appliedRoutes: HighDensityIntraNodeRoute[] | null;
  applyError: string | null;
};

const DEFAULT_PAIR_COUNT = 2;
const MIN_PAIR_COUNT = 1;
const MAX_PAIR_COUNT = 6;

const createRandomCacheMatchSample = (pairCount: number) => {
  const sampleIndex = 1_000_000 + Math.floor(Math.random() * 9_000_000);
  return canonicalizeDatasetSample(
    createMatchSampleWithPairCount(sampleIndex, pairCount),
  );
};

export default function CacheMatchPage() {
  const [pairCount, setPairCount] = useState(DEFAULT_PAIR_COUNT);
  const [generatedSample, setGeneratedSample] = useState<DatasetSample>(() =>
    createRandomCacheMatchSample(DEFAULT_PAIR_COUNT),
  );
  const [cacheMatch, setCacheMatch] = useState<CacheMatchResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRunInitialLookupRef = useRef(false);

  const lookupNearestCacheMatch = useCallback(
    async (sample: DatasetSample, nextPairCount: number) => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/get_nearest_solve_cache_match", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            pointPairCount: nextPairCount,
            sample,
          }),
        });

        const payload = (await response.json()) as
          | CacheMatchResponse
          | { error: string };

        if (!response.ok || "error" in payload) {
          throw new Error(
            "error" in payload
              ? payload.error
              : `Solve-cache lookup failed with status ${response.status}`,
          );
        }

        setCacheMatch(payload);
      } catch (lookupError) {
        setError(
          lookupError instanceof Error
            ? lookupError.message
            : String(lookupError),
        );
        setCacheMatch(null);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const refreshMatch = (nextPairCount = pairCount) => {
    const nextSample = createRandomCacheMatchSample(nextPairCount);
    setGeneratedSample(nextSample);
    setCacheMatch(null);
    void lookupNearestCacheMatch(nextSample, nextPairCount);
  };

  useEffect(() => {
    if (hasRunInitialLookupRef.current) {
      return;
    }

    hasRunInitialLookupRef.current = true;
    void lookupNearestCacheMatch(generatedSample, pairCount);
  }, [generatedSample, lookupNearestCacheMatch, pairCount]);

  const appliedGeneratedSample: DatasetSample =
    cacheMatch?.appliedRoutes !== null &&
    cacheMatch?.appliedRoutes !== undefined
      ? {
          ...generatedSample,
          solvable: true,
          solution: cacheMatch.appliedRoutes,
        }
      : generatedSample;
  const generatedGraphics = mergeGraphics(
    sampleToGraphicsObject(appliedGeneratedSample),
    routesToGraphicsObject(
      appliedGeneratedSample,
      cacheMatch?.appliedRoutes ?? [],
    ),
  );
  const cacheSample = cacheMatch?.cacheSample ?? null;
  const cacheGraphics = cacheSample
    ? mergeGraphics(
        sampleToGraphicsObject(cacheSample),
        routesToGraphicsObject(cacheSample, cacheSample.solution ?? []),
      )
    : null;

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <section style={heroStyle}>
          <div style={heroHeaderStyle}>
            <div>
              <div style={eyebrowStyle}>Solve Cache</div>
              <h1 style={titleStyle}>Cache Match</h1>
              <p style={descriptionStyle}>
                This page generates a canonicalized match sample, looks up the
                nearest solve-cache entry across all 8 dihedral symmetries, and
                applies the matched cache variant after reattachment, force
                improvement, and DRC validation.
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
              <span>Lookup Status</span>
              <strong>
                {isLoading
                  ? "Searching..."
                  : error
                    ? "Failed"
                    : cacheMatch?.appliedRoutes
                      ? "Applied"
                      : cacheMatch
                        ? "Nearest Only"
                        : "Idle"}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Stored Cache Entry</span>
              <strong>
                {cacheMatch ? `#${cacheMatch.entryIndex}` : "Pending"}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Vector Distance</span>
              <strong>
                {cacheMatch ? cacheMatch.distance.toFixed(4) : "Pending"}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Matched Symmetry</span>
              <strong>{cacheMatch?.symmetry ?? "Pending"}</strong>
            </article>

            <article style={statCardStyle}>
              <span>Applied Routes</span>
              <strong>
                {cacheMatch?.appliedRoutes
                  ? cacheMatch.appliedRoutes.length
                  : 0}
              </strong>
            </article>

            <article style={statCardStyle}>
              <span>Cache Sample Routes</span>
              <strong>{cacheSample?.solution?.length ?? 0}</strong>
            </article>
          </div>

          {error ? (
            <p style={{ ...descriptionStyle, color: "#b02a37" }}>{error}</p>
          ) : null}

          {!error && cacheMatch?.applyError ? (
            <p style={{ ...descriptionStyle, color: "#b02a37" }}>
              {cacheMatch.applyError}
            </p>
          ) : null}
        </section>

        <section style={viewerGridStyle}>
          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <div>
                <div style={eyebrowStyle}>Generated</div>
                <h2 style={viewerPanelTitleStyle}>
                  Generated Sample With Applied Cache Routes
                </h2>
              </div>
            </div>

            <InteractiveGraphics graphics={generatedGraphics} height={420} />
          </article>

          <article style={viewerCardStyle}>
            <div style={viewerPanelHeaderStyle}>
              <div>
                <div style={eyebrowStyle}>Nearest Entry</div>
                <h2 style={viewerPanelTitleStyle}>
                  Matched Solve Cache Variant
                </h2>
              </div>
            </div>

            {cacheGraphics ? (
              <InteractiveGraphics graphics={cacheGraphics} height={420} />
            ) : (
              <p style={descriptionStyle}>
                {isLoading
                  ? "Looking up solve-cache entry..."
                  : "No match yet."}
              </p>
            )}
          </article>
        </section>
      </div>
    </div>
  );
}
