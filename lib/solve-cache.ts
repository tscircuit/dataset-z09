import { type DrcCheckResult, runDrcCheck } from "./drc-check";
import { runForceDirectedImprovement } from "./force-improve";
import { roundToTwoDecimals, stringifyWithFixedNumbers } from "./generator";
import { simplifyRoutes } from "./simplify";
import type {
  DatasetSample,
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
  PortPoint,
} from "./types";
import { computeVecRaw } from "./vec-raw";
import { getVectorDistance } from "./vector-search";

type CanonicalPair = {
  canonicalConnectionName: string;
  canonicalRootConnectionName?: string;
  sourceConnectionName: string;
  sourceRootConnectionName?: string;
  portPoints: [PortPoint, PortPoint];
};

type CanonicalizationResult = {
  pairs: CanonicalPair[];
  connectionNameMap: Map<string, string>;
  rootConnectionNameMap: Map<string, string>;
};

export type SolveCacheEntry = {
  sample: NodeWithPortPoints;
  solution: HighDensityIntraNodeRoute[];
  vecRaw: number[];
};

export const DIHEDRAL_SYMMETRIES = [
  "identity",
  "flipX",
  "flipY",
  "rotate90",
  "rotate180",
  "rotate270",
  "flipDiagonal",
  "flipAntiDiagonal",
] as const;

export type DihedralSymmetry = (typeof DIHEDRAL_SYMMETRIES)[number];

export const SOLVE_CACHE_SYMMETRIES = [
  ...DIHEDRAL_SYMMETRIES,
  "flipZ",
  "flipX+flipZ",
  "flipY+flipZ",
  "rotate90+flipZ",
  "rotate180+flipZ",
  "rotate270+flipZ",
  "flipDiagonal+flipZ",
  "flipAntiDiagonal+flipZ",
] as const;

export type SolveCacheSymmetry = (typeof SOLVE_CACHE_SYMMETRIES)[number];

export type SolveCacheFile = {
  pointPairCount: number;
  entries: SolveCacheEntry[];
};

export type SolveCacheCandidate = {
  distance: number;
  entry: SolveCacheEntry;
  sourceEntry: SolveCacheEntry;
  symmetry: SolveCacheSymmetry;
};

export type ReattachedSolveCacheHit = {
  routes: HighDensityIntraNodeRoute[];
  drc: DrcCheckResult;
};

export type SolveCacheApplyFailure =
  | {
      ok: false;
      reason: "reattach-failed";
    }
  | {
      ok: false;
      reason: "drc-failed";
      improvedRoutes: HighDensityIntraNodeRoute[];
      rawRoutes: HighDensityIntraNodeRoute[];
      improvedDrc: DrcCheckResult;
      rawDrc: DrcCheckResult;
    };

export type SolveCacheApplyResult =
  | ({ ok: true } & ReattachedSolveCacheHit)
  | SolveCacheApplyFailure;

export type SolveCacheNearestFailure = {
  candidate: SolveCacheCandidate;
  failure: SolveCacheApplyFailure;
};

export type SolveCacheMatchResult = {
  match: {
    candidate: SolveCacheCandidate;
    applied: ReattachedSolveCacheHit;
  } | null;
  nearestFailure: SolveCacheNearestFailure | null;
};

type TryApplySolveCacheEntryOptions = {
  forceImprovementPasses?: number;
};

const TAU = Math.PI * 2;
export const DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY = 16;
const DEFAULT_REUSE_FORCE_IMPROVEMENT_PASSES = 100;
const DEFAULT_CACHE_VALIDATION_FORCE_IMPROVEMENT_PASSES = 500;

const normalizeAngle = (angle: number) => {
  const normalizedAngle = angle % TAU;
  return normalizedAngle < 0 ? normalizedAngle + TAU : normalizedAngle;
};

const compareNumbers = (left: number, right: number) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareOptionalStrings = (left?: string, right?: string) => {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left.localeCompare(right);
};

const comparePortPoints = (
  left: PortPoint,
  right: PortPoint,
  center: { x: number; y: number },
) => {
  const leftAngle = normalizeAngle(
    Math.atan2(left.y - center.y, left.x - center.x),
  );
  const rightAngle = normalizeAngle(
    Math.atan2(right.y - center.y, right.x - center.x),
  );

  return (
    compareNumbers(left.z, right.z) ||
    compareNumbers(leftAngle, rightAngle) ||
    compareNumbers(left.x, right.x) ||
    compareNumbers(left.y, right.y) ||
    compareOptionalStrings(left.portPointId, right.portPointId)
  );
};

const comparePairs = (
  left: [PortPoint, PortPoint],
  right: [PortPoint, PortPoint],
  center: { x: number; y: number },
) =>
  comparePortPoints(left[0], right[0], center) ||
  comparePortPoints(left[1], right[1], center);

const clonePortPoint = (portPoint: PortPoint): PortPoint => ({
  ...portPoint,
});

const cloneRoute = (
  route: HighDensityIntraNodeRoute,
): HighDensityIntraNodeRoute => ({
  ...route,
  route: route.route.map((point) => ({ ...point })),
  vias: route.vias.map((via) => ({ ...via })),
  jumpers: route.jumpers?.map((jumper) => ({
    ...jumper,
    start: { ...jumper.start },
    end: { ...jumper.end },
  })),
});

const symmetryVariantCache = new WeakMap<
  SolveCacheEntry,
  Map<SolveCacheSymmetry, SolveCacheEntry>
>();

const FLIP_Z_SUFFIX = "+flipZ";

const symmetryHasFlipZ = (symmetry: SolveCacheSymmetry) =>
  symmetry === "flipZ" || symmetry.endsWith(FLIP_Z_SUFFIX);

const getPlanarSymmetry = (symmetry: SolveCacheSymmetry): DihedralSymmetry => {
  if (symmetry === "flipZ") {
    return "identity";
  }

  if (symmetry.endsWith(FLIP_Z_SUFFIX)) {
    return symmetry.slice(0, -FLIP_Z_SUFFIX.length) as DihedralSymmetry;
  }

  return symmetry as DihedralSymmetry;
};

const flipPointZ = (z: number) => {
  if (z === 0) return 1;
  if (z === 1) return 0;
  return z;
};

const symmetrySwapsAxes = (symmetry: DihedralSymmetry) =>
  symmetry === "rotate90" ||
  symmetry === "rotate270" ||
  symmetry === "flipDiagonal" ||
  symmetry === "flipAntiDiagonal";

const transformRelativePoint = (
  point: { x: number; y: number },
  symmetry: DihedralSymmetry,
) => {
  switch (symmetry) {
    case "identity":
      return { x: point.x, y: point.y };
    case "flipX":
      return { x: -point.x, y: point.y };
    case "flipY":
      return { x: point.x, y: -point.y };
    case "rotate90":
      return { x: -point.y, y: point.x };
    case "rotate180":
      return { x: -point.x, y: -point.y };
    case "rotate270":
      return { x: point.y, y: -point.x };
    case "flipDiagonal":
      return { x: point.y, y: point.x };
    case "flipAntiDiagonal":
      return { x: -point.y, y: -point.x };
  }
};

const transformPointWithSymmetry = (
  point: { x: number; y: number },
  center: { x: number; y: number },
  symmetry: SolveCacheSymmetry,
) => {
  const planarSymmetry = getPlanarSymmetry(symmetry);
  const transformedPoint = transformRelativePoint(
    {
      x: point.x - center.x,
      y: point.y - center.y,
    },
    planarSymmetry,
  );

  return {
    x: roundToTwoDecimals(center.x + transformedPoint.x),
    y: roundToTwoDecimals(center.y + transformedPoint.y),
  };
};

const transformNodeWithPortPointsBySymmetry = (
  nodeWithPortPoints: NodeWithPortPoints,
  symmetry: SolveCacheSymmetry,
): NodeWithPortPoints => ({
  ...nodeWithPortPoints,
  width: symmetrySwapsAxes(getPlanarSymmetry(symmetry))
    ? nodeWithPortPoints.height
    : nodeWithPortPoints.width,
  height: symmetrySwapsAxes(getPlanarSymmetry(symmetry))
    ? nodeWithPortPoints.width
    : nodeWithPortPoints.height,
  portPoints: nodeWithPortPoints.portPoints.map((portPoint) => ({
    ...portPoint,
    z: symmetryHasFlipZ(symmetry) ? flipPointZ(portPoint.z) : portPoint.z,
    ...transformPointWithSymmetry(
      portPoint,
      nodeWithPortPoints.center,
      symmetry,
    ),
  })),
});

const transformRouteBySymmetry = (
  route: HighDensityIntraNodeRoute,
  center: { x: number; y: number },
  symmetry: SolveCacheSymmetry,
): HighDensityIntraNodeRoute => ({
  ...cloneRoute(route),
  route: route.route.map((point) => ({
    ...point,
    z: symmetryHasFlipZ(symmetry) ? flipPointZ(point.z) : point.z,
    ...transformPointWithSymmetry(point, center, symmetry),
  })),
  vias: route.vias.map((via) =>
    transformPointWithSymmetry(via, center, symmetry),
  ),
  jumpers: route.jumpers?.map((jumper) => ({
    ...jumper,
    start: transformPointWithSymmetry(jumper.start, center, symmetry),
    end: transformPointWithSymmetry(jumper.end, center, symmetry),
  })),
});

export const getSolveCacheEntrySymmetryVariant = (
  entry: SolveCacheEntry,
  symmetry: SolveCacheSymmetry,
): SolveCacheEntry => {
  if (symmetry === "identity") {
    return entry;
  }

  const cachedVariants = symmetryVariantCache.get(entry);
  const cachedVariant = cachedVariants?.get(symmetry);
  if (cachedVariant) {
    return cachedVariant;
  }

  const transformedSample = transformNodeWithPortPointsBySymmetry(
    entry.sample,
    symmetry,
  );
  const transformedSolution = entry.solution.map((route) =>
    transformRouteBySymmetry(route, entry.sample.center, symmetry),
  );
  const transformedEntry = createSolveCacheEntry(
    transformedSample,
    transformedSolution,
  );

  if (cachedVariants) {
    cachedVariants.set(symmetry, transformedEntry);
  } else {
    symmetryVariantCache.set(entry, new Map([[symmetry, transformedEntry]]));
  }

  return transformedEntry;
};

const toDatasetSample = (
  nodeWithPortPoints: NodeWithPortPoints,
): DatasetSample => ({
  ...nodeWithPortPoints,
  solvable: false,
  solution: null,
});

const getPointPairCount = (nodeWithPortPoints: NodeWithPortPoints) =>
  nodeWithPortPoints.portPoints.length / 2;

const getCanonicalizationResult = (
  nodeWithPortPoints: NodeWithPortPoints,
): CanonicalizationResult => {
  if (nodeWithPortPoints.portPoints.length % 2 !== 0) {
    throw new Error(
      `Expected an even number of port points, got ${nodeWithPortPoints.portPoints.length}`,
    );
  }

  const portPointsByConnection = new Map<string, PortPoint[]>();

  for (const portPoint of nodeWithPortPoints.portPoints) {
    const existingPortPoints =
      portPointsByConnection.get(portPoint.connectionName) ?? [];
    existingPortPoints.push(clonePortPoint(portPoint));
    portPointsByConnection.set(portPoint.connectionName, existingPortPoints);
  }

  const sortedPairs = [...portPointsByConnection.entries()]
    .map(([connectionName, portPoints]) => {
      if (portPoints.length !== 2) {
        throw new Error(
          `Expected exactly 2 port points for ${connectionName}, got ${portPoints.length}`,
        );
      }

      const pair = [...portPoints].sort((leftPortPoint, rightPortPoint) =>
        comparePortPoints(
          leftPortPoint,
          rightPortPoint,
          nodeWithPortPoints.center,
        ),
      ) as [
        PortPoint,
        PortPoint,
      ];

      return {
        sourceConnectionName: connectionName,
        sourceRootConnectionName: pair[0].rootConnectionName,
        pair,
      };
    })
    .sort((left, right) => {
      const pairComparison = comparePairs(
        left.pair,
        right.pair,
        nodeWithPortPoints.center,
      );
      if (pairComparison !== 0) {
        return pairComparison;
      }

      return left.sourceConnectionName.localeCompare(
        right.sourceConnectionName,
      );
    });

  const connectionNameMap = new Map<string, string>();
  const rootConnectionNameMap = new Map<string, string>();
  let rootConnectionIndex = 0;

  const pairs = sortedPairs.map(
    ({ sourceConnectionName, sourceRootConnectionName, pair }, index) => {
      const canonicalConnectionName = `conn${index.toString().padStart(2, "0")}`;
      connectionNameMap.set(sourceConnectionName, canonicalConnectionName);

      let canonicalRootConnectionName: string | undefined;
      if (sourceRootConnectionName !== undefined) {
        canonicalRootConnectionName = rootConnectionNameMap.get(
          sourceRootConnectionName,
        );
        if (!canonicalRootConnectionName) {
          canonicalRootConnectionName = `root${rootConnectionIndex
            .toString()
            .padStart(2, "0")}`;
          rootConnectionNameMap.set(
            sourceRootConnectionName,
            canonicalRootConnectionName,
          );
          rootConnectionIndex += 1;
        }
      }

      return {
        canonicalConnectionName,
        canonicalRootConnectionName,
        sourceConnectionName,
        sourceRootConnectionName,
        portPoints: pair,
      };
    },
  );

  return {
    pairs,
    connectionNameMap,
    rootConnectionNameMap,
  };
};

const applyCanonicalizationToSolution = (
  solution: HighDensityIntraNodeRoute[] | null,
  canonicalization: CanonicalizationResult,
): HighDensityIntraNodeRoute[] | null => {
  if (!solution) return null;

  const routes = solution.map((route) => {
    const canonicalConnectionName = canonicalization.connectionNameMap.get(
      route.connectionName,
    );
    if (!canonicalConnectionName) {
      throw new Error(
        `Unable to canonicalize route ${route.connectionName}: missing connection mapping`,
      );
    }

    return {
      ...cloneRoute(route),
      connectionName: canonicalConnectionName,
      ...(route.rootConnectionName === undefined
        ? { rootConnectionName: undefined }
        : {
            rootConnectionName:
              canonicalization.rootConnectionNameMap.get(
                route.rootConnectionName,
              ) ?? route.rootConnectionName,
          }),
    };
  });

  routes.sort((left, right) =>
    left.connectionName.localeCompare(right.connectionName),
  );

  return routes;
};

export const canonicalizeNodeWithPortPoints = (
  nodeWithPortPoints: NodeWithPortPoints,
): NodeWithPortPoints => {
  const canonicalization = getCanonicalizationResult(nodeWithPortPoints);

  return {
    ...nodeWithPortPoints,
    portPoints: canonicalization.pairs.flatMap((pair) =>
      pair.portPoints.map((portPoint, pointIndex) => ({
        ...portPoint,
        connectionName: pair.canonicalConnectionName,
        ...(pair.canonicalRootConnectionName === undefined
          ? { rootConnectionName: undefined }
          : { rootConnectionName: pair.canonicalRootConnectionName }),
        portPointId: `${pair.canonicalConnectionName}-${pointIndex === 0 ? "a" : "b"}`,
      })),
    ),
  };
};

export const canonicalizeDatasetSample = (
  sample: DatasetSample,
): DatasetSample => {
  const canonicalization = getCanonicalizationResult(sample);
  const nodeWithPortPoints = canonicalizeNodeWithPortPoints(sample);

  return {
    ...sample,
    ...nodeWithPortPoints,
    solution: applyCanonicalizationToSolution(
      sample.solution,
      canonicalization,
    ),
    vecRaw: computeVecRaw(toDatasetSample(nodeWithPortPoints)),
  };
};

export const createSolveCacheEntry = (
  sample: NodeWithPortPoints,
  solution: HighDensityIntraNodeRoute[],
): SolveCacheEntry => {
  const canonicalSample = canonicalizeNodeWithPortPoints(sample);
  const canonicalization = getCanonicalizationResult(sample);
  const canonicalSolution = applyCanonicalizationToSolution(
    solution,
    canonicalization,
  );

  return {
    sample: canonicalSample,
    solution: canonicalSolution ?? [],
    vecRaw: computeVecRaw(toDatasetSample(canonicalSample)),
  };
};

export const createEmptySolveCache = (
  pointPairCount: number,
): SolveCacheFile => ({
  pointPairCount,
  entries: [],
});

export const parseSolveCacheFile = (
  value: unknown,
  pointPairCount: number,
): SolveCacheFile => {
  if (Array.isArray(value)) {
    return {
      pointPairCount,
      entries: (value as SolveCacheEntry[]).map((entry) =>
        createSolveCacheEntry(entry.sample, entry.solution),
      ),
    };
  }

  if (!value || typeof value !== "object") {
    throw new Error("Solve cache file must contain an object or an array.");
  }

  const solveCache = value as Partial<SolveCacheFile>;
  if (
    solveCache.pointPairCount !== undefined &&
    solveCache.pointPairCount !== pointPairCount
  ) {
    throw new Error(
      `Solve cache pointPairCount mismatch: expected ${pointPairCount}, got ${solveCache.pointPairCount}`,
    );
  }

  return {
    pointPairCount,
    entries: (solveCache.entries ?? []).map((entry) =>
      createSolveCacheEntry(entry.sample, entry.solution ?? []),
    ),
  };
};

export const serializeSolveCacheFile = (solveCache: SolveCacheFile) =>
  `${stringifyWithFixedNumbers(solveCache)}\n`;

export const getSolveCacheCandidates = (
  targetSample: NodeWithPortPoints,
  entries: SolveCacheEntry[],
): SolveCacheCandidate[] => {
  const vecRaw = computeVecRaw(toDatasetSample(targetSample));
  const candidates: SolveCacheCandidate[] = [];

  for (const sourceEntry of entries) {
    for (const symmetry of SOLVE_CACHE_SYMMETRIES) {
      const entry = getSolveCacheEntrySymmetryVariant(sourceEntry, symmetry);
      if (entry.vecRaw.length !== vecRaw.length) {
        continue;
      }

      candidates.push({
        sourceEntry,
        symmetry,
        entry,
        distance: getVectorDistance(vecRaw, entry.vecRaw),
      });
    }
  }

  return candidates.sort((left, right) => left.distance - right.distance);
};

const scalePointToTarget = (
  point: { x: number; y: number },
  sourceSample: NodeWithPortPoints,
  targetSample: NodeWithPortPoints,
) => ({
  x: roundToTwoDecimals(
    targetSample.center.x +
      ((point.x - sourceSample.center.x) * targetSample.width) /
        sourceSample.width,
  ),
  y: roundToTwoDecimals(
    targetSample.center.y +
      ((point.y - sourceSample.center.y) * targetSample.height) /
        sourceSample.height,
  ),
});

export const scaleRouteToNode = (
  route: HighDensityIntraNodeRoute,
  sourceSample: NodeWithPortPoints,
  targetSample: NodeWithPortPoints,
): HighDensityIntraNodeRoute => ({
  ...route,
  route: route.route.map((point) => ({
    ...point,
    ...scalePointToTarget(point, sourceSample, targetSample),
  })),
  vias: route.vias.map((via) =>
    scalePointToTarget(via, sourceSample, targetSample),
  ),
  jumpers: route.jumpers?.map((jumper) => ({
    ...jumper,
    start: scalePointToTarget(jumper.start, sourceSample, targetSample),
    end: scalePointToTarget(jumper.end, sourceSample, targetSample),
  })),
});

const reverseRoute = (
  route: HighDensityIntraNodeRoute,
): HighDensityIntraNodeRoute => ({
  ...route,
  route: route.route.toReversed(),
  vias: route.vias.toReversed(),
  jumpers: route.jumpers?.toReversed().map((jumper) => ({
    ...jumper,
    start: { ...jumper.end },
    end: { ...jumper.start },
  })),
});

const getPortPointsByConnectionName = (
  nodeWithPortPoints: NodeWithPortPoints,
) => {
  const portPointsByConnection = new Map<string, [PortPoint, PortPoint]>();

  for (
    let index = 0;
    index < nodeWithPortPoints.portPoints.length;
    index += 2
  ) {
    const firstPortPoint = nodeWithPortPoints.portPoints[index];
    const secondPortPoint = nodeWithPortPoints.portPoints[index + 1];

    if (!firstPortPoint || !secondPortPoint) continue;

    portPointsByConnection.set(firstPortPoint.connectionName, [
      firstPortPoint,
      secondPortPoint,
    ]);
  }

  return portPointsByConnection;
};

const getPointDistance = (
  left: { x: number; y: number },
  right: { x: number; y: number },
) => Math.hypot(left.x - right.x, left.y - right.y);

export const reattachRouteToNode = (
  route: HighDensityIntraNodeRoute,
  nodeWithPortPoints: NodeWithPortPoints,
): HighDensityIntraNodeRoute | null => {
  const connectionPortPoints = getPortPointsByConnectionName(
    nodeWithPortPoints,
  ).get(route.connectionName);
  if (!connectionPortPoints || route.route.length === 0) {
    return null;
  }

  const firstPoint = route.route[0];
  const lastPoint = route.route.at(-1);
  if (!firstPoint || !lastPoint) {
    return null;
  }

  const [startPortPoint, endPortPoint] = connectionPortPoints;
  const forwardDistance =
    getPointDistance(firstPoint, startPortPoint) +
    getPointDistance(lastPoint, endPortPoint);
  const reverseDistance =
    getPointDistance(firstPoint, endPortPoint) +
    getPointDistance(lastPoint, startPortPoint);

  const normalizedRoute =
    reverseDistance < forwardDistance ? reverseRoute(route) : cloneRoute(route);
  const normalizedFirstPoint = normalizedRoute.route[0];
  const normalizedLastPoint = normalizedRoute.route.at(-1);

  if (!normalizedFirstPoint || !normalizedLastPoint) {
    return null;
  }

  normalizedRoute.route[0] = {
    ...normalizedFirstPoint,
    x: startPortPoint.x,
    y: startPortPoint.y,
    z: startPortPoint.z,
  };
  normalizedRoute.route[normalizedRoute.route.length - 1] = {
    ...normalizedLastPoint,
    x: endPortPoint.x,
    y: endPortPoint.y,
    z: endPortPoint.z,
  };

  return normalizedRoute;
};

const getValidRoutesForSample = (
  targetSample: NodeWithPortPoints,
  routes: HighDensityIntraNodeRoute[],
  forceImprovementPasses: number,
): SolveCacheApplyResult => {
  const datasetSample = toDatasetSample(targetSample);
  const simplifiedRoutes = simplifyRoutes(routes);
  const improvedRoutes =
    forceImprovementPasses > 0
      ? runForceDirectedImprovement(
          datasetSample,
          simplifiedRoutes,
          forceImprovementPasses,
        ).routes
      : simplifiedRoutes;
  const improvedDrc = runDrcCheck(targetSample, improvedRoutes);

  if (improvedDrc.ok) {
    return {
      ok: true,
      routes: improvedRoutes,
      drc: improvedDrc,
    };
  }

  const rawDrc = runDrcCheck(targetSample, routes);
  if (rawDrc.ok) {
    return {
      ok: true,
      routes,
      drc: rawDrc,
    };
  }

  return {
    ok: false,
    reason: "drc-failed",
    improvedRoutes,
    rawRoutes: routes,
    improvedDrc,
    rawDrc,
  };
};

export const diagnoseSolveCacheEntryApplication = (
  targetSample: NodeWithPortPoints,
  entry: SolveCacheEntry,
  options?: TryApplySolveCacheEntryOptions,
): SolveCacheApplyResult => {
  const scaledRoutes = entry.solution.map((route) =>
    scaleRouteToNode(route, entry.sample, targetSample),
  );
  const reattachedRoutes = scaledRoutes.map((route) =>
    reattachRouteToNode(route, targetSample),
  );

  if (reattachedRoutes.some((route) => route === null)) {
    return {
      ok: false,
      reason: "reattach-failed",
    };
  }

  const routes = reattachedRoutes.filter(
    (route): route is HighDensityIntraNodeRoute => route !== null,
  );

  return getValidRoutesForSample(
    targetSample,
    routes,
    options?.forceImprovementPasses ?? DEFAULT_REUSE_FORCE_IMPROVEMENT_PASSES,
  );
};

export const tryApplySolveCacheEntry = (
  targetSample: NodeWithPortPoints,
  entry: SolveCacheEntry,
  options?: TryApplySolveCacheEntryOptions,
): ReattachedSolveCacheHit | null => {
  const result = diagnoseSolveCacheEntryApplication(
    targetSample,
    entry,
    options,
  );

  return result.ok
    ? {
        routes: result.routes,
        drc: result.drc,
      }
    : null;
};

export const findSolveCacheMatch = (
  targetSample: NodeWithPortPoints,
  entries: SolveCacheEntry[],
  options?: TryApplySolveCacheEntryOptions & {
    maxCandidatesToTry?: number;
  },
): SolveCacheMatchResult => {
  const candidates = getSolveCacheCandidates(targetSample, entries).slice(
    0,
    options?.maxCandidatesToTry ?? DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY,
  );
  let nearestFailure: SolveCacheNearestFailure | null = null;

  for (const candidate of candidates) {
    const result = diagnoseSolveCacheEntryApplication(
      targetSample,
      candidate.entry,
      {
        forceImprovementPasses: options?.forceImprovementPasses,
      },
    );

    if (result.ok) {
      return {
        match: {
          candidate,
          applied: {
            routes: result.routes,
            drc: result.drc,
          },
        },
        nearestFailure,
      };
    }

    if (nearestFailure === null) {
      nearestFailure = {
        candidate,
        failure: result,
      };
    }
  }

  return {
    match: null,
    nearestFailure,
  };
};

export const createValidatedSolveCacheEntry = (
  sample: NodeWithPortPoints,
  solution: HighDensityIntraNodeRoute[],
  options?: TryApplySolveCacheEntryOptions,
): SolveCacheEntry | null => {
  const entry = createSolveCacheEntry(sample, solution);
  const validatedEntry = tryApplySolveCacheEntry(entry.sample, entry, {
    forceImprovementPasses:
      options?.forceImprovementPasses ??
      DEFAULT_CACHE_VALIDATION_FORCE_IMPROVEMENT_PASSES,
  });

  if (!validatedEntry) {
    return null;
  }

  return {
    ...entry,
    solution: validatedEntry.routes,
  };
};

export const getSolveCachePointPairCount = (solveCache: SolveCacheFile) =>
  solveCache.pointPairCount;

export const getNodePointPairCount = getPointPairCount;
