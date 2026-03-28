import { expect, test } from "bun:test";
import {
  SOLVE_CACHE_SYMMETRIES,
  canonicalizeDatasetSample,
  createSolveCacheEntry,
  createValidatedSolveCacheEntry,
  findSolveCacheMatch,
  getSolveCacheCandidates,
  tryApplySolveCacheEntry,
} from "../lib/solve-cache";
import type { DatasetSample } from "../lib/types";

test("canonicalizeDatasetSample stabilizes pair ordering across connection renames", () => {
  const leftSample: DatasetSample = {
    capacityMeshNodeId: "left",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: false,
    solution: null,
    portPoints: [
      {
        connectionName: "beta",
        rootConnectionName: "rootB",
        portPointId: "beta-b",
        x: 2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "alpha",
        rootConnectionName: "rootA",
        portPointId: "alpha-a",
        x: -2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "alpha",
        rootConnectionName: "rootA",
        portPointId: "alpha-b",
        x: 0,
        y: 1,
        z: 1,
      },
      {
        connectionName: "beta",
        rootConnectionName: "rootB",
        portPointId: "beta-a",
        x: 0,
        y: -1,
        z: 1,
      },
    ],
  };

  const rightSample: DatasetSample = {
    ...leftSample,
    capacityMeshNodeId: "right",
    portPoints: [
      {
        connectionName: "zeta",
        rootConnectionName: "shared-z",
        portPointId: "zeta-1",
        x: 0,
        y: -1,
        z: 1,
      },
      {
        connectionName: "eta",
        rootConnectionName: "shared-e",
        portPointId: "eta-1",
        x: 0,
        y: 1,
        z: 1,
      },
      {
        connectionName: "eta",
        rootConnectionName: "shared-e",
        portPointId: "eta-2",
        x: -2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "zeta",
        rootConnectionName: "shared-z",
        portPointId: "zeta-2",
        x: 2,
        y: 0,
        z: 0,
      },
    ],
  };

  expect(canonicalizeDatasetSample(leftSample).vecRaw).toEqual(
    canonicalizeDatasetSample(rightSample).vecRaw,
  );
});

test("canonicalizeDatasetSample orders pairs by z=0 sweep before z=1 sweep", () => {
  const sample: DatasetSample = {
    capacityMeshNodeId: "z-sweep-order",
    center: { x: 0, y: 0 },
    width: 4,
    height: 4,
    availableZ: [0, 1],
    solvable: false,
    solution: null,
    portPoints: [
      {
        connectionName: "high",
        portPointId: "high-a",
        x: 2,
        y: 0,
        z: 1,
      },
      {
        connectionName: "high",
        portPointId: "high-b",
        x: 0,
        y: 2,
        z: 1,
      },
      {
        connectionName: "low",
        portPointId: "low-a",
        x: -2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "low",
        portPointId: "low-b",
        x: 0,
        y: -2,
        z: 0,
      },
    ],
  };

  const canonicalSample = canonicalizeDatasetSample(sample);

  expect(canonicalSample.portPoints[0]).toMatchObject({
    connectionName: "conn00",
    z: 0,
  });
  expect(canonicalSample.portPoints[1]).toMatchObject({
    connectionName: "conn00",
    z: 0,
  });
  expect(canonicalSample.portPoints[2]).toMatchObject({
    connectionName: "conn01",
    z: 1,
  });
  expect(canonicalSample.portPoints[3]).toMatchObject({
    connectionName: "conn01",
    z: 1,
  });
});

test("tryApplySolveCacheEntry reattaches cached routes to the target sample", () => {
  const sample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-cache",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0.8, z: 0 },
          { x: 0, y: 0.8, z: 0 },
          { x: 2, y: 0.8, z: 0 },
        ],
        vias: [],
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: -0.8, z: 1 },
          { x: 0, y: -0.8, z: 1 },
          { x: 2, y: -0.8, z: 1 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        portPointId: "conn01-a",
        x: 2,
        y: 0.8,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: 2,
        y: -0.8,
        z: 1,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: -2,
        y: -0.8,
        z: 1,
      },
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        portPointId: "conn01-b",
        x: -2,
        y: 0.8,
        z: 0,
      },
    ],
  });

  const cacheEntry = createSolveCacheEntry(sample, sample.solution ?? []);
  const appliedCacheEntry = tryApplySolveCacheEntry(sample, cacheEntry);

  expect(appliedCacheEntry).not.toBeNull();
  expect(appliedCacheEntry?.drc.ok).toBe(true);
  expect(appliedCacheEntry?.routes).toHaveLength(2);

  const firstRoute = appliedCacheEntry?.routes[0];
  const firstPortPoint = sample.portPoints.find(
    (portPoint) => portPoint.connectionName === firstRoute?.connectionName,
  );

  expect(firstRoute?.route[0]).toMatchObject({
    x: firstPortPoint?.x,
    y: firstPortPoint?.y,
    z: firstPortPoint?.z,
  });
});

test("createValidatedSolveCacheEntry rejects routes that still fail drc", () => {
  const sample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-invalid-cache",
    center: { x: 0, y: 0 },
    width: 4,
    height: 4,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0, z: 0 },
          { x: 2, y: 0, z: 0 },
        ],
        vias: [],
      },
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: 0, y: -2, z: 0 },
          { x: 0, y: 2, z: 0 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        portPointId: "conn01-a",
        x: 0,
        y: -2,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "conn01",
        rootConnectionName: "root01",
        portPointId: "conn01-b",
        x: 0,
        y: 2,
        z: 0,
      },
    ],
  });

  expect(
    createValidatedSolveCacheEntry(sample, sample.solution ?? []),
  ).toBeNull();
});

test("getSolveCacheCandidates expands cache entries across all planar and z-flip symmetries", () => {
  const sample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-dihedral-count",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0.8, z: 0 },
          { x: 0, y: 0.8, z: 0 },
          { x: 2, y: 0.8, z: 0 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0.8,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0.8,
        z: 0,
      },
    ],
  });

  const cacheEntry = createSolveCacheEntry(sample, sample.solution ?? []);
  const candidates = getSolveCacheCandidates(sample, [cacheEntry]);

  expect(candidates).toHaveLength(SOLVE_CACHE_SYMMETRIES.length);
  expect(new Set(candidates.map((candidate) => candidate.symmetry))).toEqual(
    new Set(SOLVE_CACHE_SYMMETRIES),
  );
});

test("getSolveCacheCandidates matches rotated cache entries through dihedral symmetry", () => {
  const cacheSample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-dihedral-cache",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0.8, z: 0 },
          { x: 0, y: 0.8, z: 0 },
          { x: 2, y: 0.8, z: 0 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0.8,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0.8,
        z: 0,
      },
    ],
  });

  const rotatedTargetSample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-dihedral-rotated",
    center: { x: 0, y: 0 },
    width: 2,
    height: 4,
    availableZ: [0, 1],
    solvable: false,
    solution: null,
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -0.8,
        y: -2,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: -0.8,
        y: 2,
        z: 0,
      },
    ],
  });

  const cacheEntry = createSolveCacheEntry(
    cacheSample,
    cacheSample.solution ?? [],
  );
  const [bestCandidate] = getSolveCacheCandidates(rotatedTargetSample, [
    cacheEntry,
  ]);

  expect(bestCandidate).toBeDefined();
  expect(bestCandidate?.symmetry).toBe("rotate90");
  expect(bestCandidate?.distance).toBe(0);
  expect(bestCandidate?.entry.sample.width).toBe(rotatedTargetSample.width);
  expect(bestCandidate?.entry.sample.height).toBe(rotatedTargetSample.height);

  const appliedCacheEntry = bestCandidate
    ? tryApplySolveCacheEntry(rotatedTargetSample, bestCandidate.entry)
    : null;

  expect(appliedCacheEntry).not.toBeNull();
  expect(appliedCacheEntry?.drc.ok).toBe(true);
});

test("getSolveCacheCandidates matches z-flipped cache entries through symmetry", () => {
  const cacheSample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-zflip-cache",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0.8, z: 0 },
          { x: 0, y: 0.8, z: 0 },
          { x: 2, y: 0.8, z: 0 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0.8,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0.8,
        z: 0,
      },
    ],
  });

  const zFlippedTargetSample: DatasetSample = canonicalizeDatasetSample({
    ...cacheSample,
    capacityMeshNodeId: "sample-zflip-target",
    solvable: false,
    solution: null,
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0.8,
        z: 1,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0.8,
        z: 1,
      },
    ],
  });

  const cacheEntry = createSolveCacheEntry(
    cacheSample,
    cacheSample.solution ?? [],
  );
  const [bestCandidate] = getSolveCacheCandidates(zFlippedTargetSample, [
    cacheEntry,
  ]);

  expect(bestCandidate).toBeDefined();
  expect(bestCandidate?.symmetry).toBe("flipZ");
  expect(bestCandidate?.distance).toBe(0);
  expect(bestCandidate?.entry.sample.portPoints.every((point) => point.z === 1)).toBe(
    true,
  );
  expect(bestCandidate?.entry.solution[0]?.route.every((point) => point.z === 1)).toBe(
    true,
  );

  const appliedCacheEntry = bestCandidate
    ? tryApplySolveCacheEntry(zFlippedTargetSample, bestCandidate.entry)
    : null;

  expect(appliedCacheEntry).not.toBeNull();
  expect(appliedCacheEntry?.drc.ok).toBe(true);
});

test("findSolveCacheMatch returns a later successful candidate when the nearest one fails", () => {
  const sample: DatasetSample = canonicalizeDatasetSample({
    capacityMeshNodeId: "sample-match-search",
    center: { x: 0, y: 0 },
    width: 4,
    height: 2,
    availableZ: [0, 1],
    solvable: true,
    solution: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        traceThickness: 0.1,
        viaDiameter: 0.3,
        route: [
          { x: -2, y: 0, z: 0 },
          { x: 2, y: 0, z: 0 },
        ],
        vias: [],
      },
    ],
    portPoints: [
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-a",
        x: -2,
        y: 0,
        z: 0,
      },
      {
        connectionName: "conn00",
        rootConnectionName: "root00",
        portPointId: "conn00-b",
        x: 2,
        y: 0,
        z: 0,
      },
    ],
  });

  const invalidNearestEntry = createSolveCacheEntry(sample, [
    {
      connectionName: "conn00",
      rootConnectionName: "root00",
      traceThickness: 0.1,
      viaDiameter: 0.3,
      route: [
        { x: -2, y: 0, z: 0 },
        { x: -2, y: 0, z: 1 },
        { x: 2, y: 0, z: 1 },
        { x: 2, y: 0, z: 0 },
      ],
      vias: [],
    },
  ]);
  const validEntry = createSolveCacheEntry(sample, sample.solution ?? []);

  const match = findSolveCacheMatch(sample, [invalidNearestEntry, validEntry], {
    maxCandidatesToTry: 16,
  });

  expect(match.nearestFailure?.candidate.sourceEntry).toBe(invalidNearestEntry);
  expect(match.match?.candidate.sourceEntry).toBe(validEntry);
  expect(match.match?.applied.drc.ok).toBe(true);
});
