import type { DatasetSample, HighDensityIntraNodeRoute } from "./types";

type Vector = {
  x: number;
  y: number;
};

type Bounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type MutableNode = {
  x: number;
  y: number;
  originalX: number;
  originalY: number;
  pointIndexes: number[];
  fixed: boolean;
};

type MutableRoute = {
  route: HighDensityIntraNodeRoute;
  rootConnectionName: string;
  nodes: MutableNode[];
};

type ForceElementBase = {
  routeIndex: number;
  rootConnectionName: string;
  nodeIndex: number;
  x: number;
  y: number;
  fixed: boolean;
};

type PointForceElement = ForceElementBase & {
  kind: "point";
  z: number;
};

type ViaForceElement = ForceElementBase & {
  kind: "via";
};

type ForceElement = PointForceElement | ViaForceElement;

type SegmentObstacle = {
  routeIndex: number;
  rootConnectionName: string;
  z: number;
  startNodeIndex: number;
  endNodeIndex: number;
  start: Vector;
  end: Vector;
};

type ClosestPointResult = {
  point: Vector;
  t: number;
  distance: number;
};

export type ForceVector = {
  kind: "point" | "via";
  routeIndex: number;
  rootConnectionName: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
};

export type ForceImproveResult = {
  routes: HighDensityIntraNodeRoute[];
  forceVectors: ForceVector[];
  stepsCompleted: number;
};

export const TARGET_CLEARANCE = 0.2;
export const CLEARANCE_FALLOFF_DISTANCE = 0.4;
export const VIA_DIAMETER = 0.3;
export const VIA_RADIUS = VIA_DIAMETER / 2;
export const POINT_SEGMENT_TARGET_CLEARANCE = 0.25;
export const POINT_SEGMENT_FALLOFF_DISTANCE = 0.5;
export const VIA_SEGMENT_TARGET_CLEARANCE = VIA_RADIUS + 0.25;
export const VIA_SEGMENT_FALLOFF_DISTANCE = 0.5;
export const VIA_BORDER_EXTRA_CLEARANCE = 0.15;
export const VIA_BORDER_TARGET_CLEARANCE =
  VIA_SEGMENT_TARGET_CLEARANCE + VIA_BORDER_EXTRA_CLEARANCE + 0.1;
export const VIA_BORDER_FALLOFF_DISTANCE = VIA_BORDER_TARGET_CLEARANCE + 0.05;
export const VIA_VIA_REPULSION_STRENGTH = 0.034;
export const VIA_SEGMENT_REPULSION_STRENGTH = 0.18;
export const POINT_SEGMENT_REPULSION_STRENGTH = 0.06;
export const SEGMENT_SEGMENT_REPULSION_STRENGTH =
  POINT_SEGMENT_REPULSION_STRENGTH;
export const REPULSION_TAIL_RATIO = 0.08;
export const REPULSION_FALLOFF = 18;
export const INTERSECTION_FORCE_BOOST = 3.5;
export const VIA_SEGMENT_INTERSECTION_FORCE_BOOST = 12;
export const BORDER_REPULSION_STRENGTH = 0.03;
export const BORDER_REPULSION_TAIL_RATIO = 0.08;
export const BORDER_REPULSION_FALLOFF = 20;
export const VIA_BORDER_REPULSION_TAIL_RATIO = 0.015;
export const VIA_BORDER_REPULSION_FALLOFF = 80;
export const SHAPE_RESTORE_STRENGTH = 0.14;
export const PATH_SMOOTHING_STRENGTH = 0.22;
export const CLEARANCE_PROJECTION_RATIO = 0.9;
export const POINT_SEGMENT_CLEARANCE_PROJECTION_RATIO = 1.05;
export const VIA_SEGMENT_CLEARANCE_PROJECTION_RATIO = 1.35;
export const CLEARANCE_PROJECTION_PASSES = 3;
export const MAX_CLEARANCE_CORRECTION = 0.02;
export const VIA_SEGMENT_MAX_CLEARANCE_CORRECTION_MULTIPLIER = 3;
export const FINAL_CLEARANCE_PROJECTION_PASSES = 8;
export const FINAL_MAX_CLEARANCE_CORRECTION = 0.03;
export const STEP_SIZE = 0.85;
export const MAX_NODE_MOVE_PER_STEP = 0.012;
export const MIN_STEP_DECAY = 0.25;
export const FORCE_VECTOR_DISPLAY_MULTIPLIER = 5;

const ROUNDING_PRECISION = 1_000;
const POSITION_EPSILON = 1e-6;

const roundCoordinate = (value: number) =>
  Math.round(value * ROUNDING_PRECISION) / ROUNDING_PRECISION;

const addVector = (left: Vector, right: Vector): Vector => ({
  x: left.x + right.x,
  y: left.y + right.y,
});

const subtractVector = (left: Vector, right: Vector): Vector => ({
  x: left.x - right.x,
  y: left.y - right.y,
});

const scaleVector = (vector: Vector, scale: number): Vector => ({
  x: vector.x * scale,
  y: vector.y * scale,
});

const dotVector = (left: Vector, right: Vector) =>
  left.x * right.x + left.y * right.y;

const lerpVector = (start: Vector, end: Vector, t: number): Vector => ({
  x: start.x + (end.x - start.x) * t,
  y: start.y + (end.y - start.y) * t,
});

const clampUnitInterval = (value: number) =>
  Math.max(0, Math.min(value, 1));

const clampValue = (value: number, minValue: number, maxValue: number) =>
  Math.max(minValue, Math.min(value, maxValue));

const getVectorMagnitude = (vector: Vector) =>
  Math.hypot(vector.x, vector.y);

const normalizeVector = (vector: Vector, fallbackSeed: number): Vector => {
  const magnitude = getVectorMagnitude(vector);
  if (magnitude > POSITION_EPSILON) {
    return scaleVector(vector, 1 / magnitude);
  }

  const angle = fallbackSeed * 1.618_033_988_75;
  return {
    x: Math.cos(angle),
    y: Math.sin(angle),
  };
};

const getPerpendicularVector = (
  vector: Vector,
  fallbackSeed: number,
): Vector => {
  const normal = normalizeVector(
    { x: -vector.y, y: vector.x },
    fallbackSeed,
  );

  return fallbackSeed % 2 === 0 ? normal : scaleVector(normal, -1);
};

const clampVectorMagnitude = (vector: Vector, maxMagnitude: number) => {
  const magnitude = getVectorMagnitude(vector);
  if (magnitude <= maxMagnitude || magnitude <= POSITION_EPSILON) {
    return vector;
  }

  return scaleVector(vector, maxMagnitude / magnitude);
};

const getClearanceForceMagnitude = (
  distance: number,
  strength: number,
  tailRatio: number,
  falloff: number,
  intersectionBoost = INTERSECTION_FORCE_BOOST,
  targetClearance = TARGET_CLEARANCE,
  falloffDistance = CLEARANCE_FALLOFF_DISTANCE,
) => {
  const clampedDistance = Math.max(distance, 0);
  if (clampedDistance >= falloffDistance) {
    return 0;
  }

  const normalizedDistance = clampedDistance / targetClearance;

  if (normalizedDistance < 1) {
    const penetration = 1 - normalizedDistance;
    return (
      strength *
      Math.pow(penetration, 3) *
      (1 + penetration * intersectionBoost)
    );
  }

  const tailSpan = Math.max(
    falloffDistance - targetClearance,
    POSITION_EPSILON,
  );
  const tailProgress = (clampedDistance - targetClearance) / tailSpan;
  const tailMagnitude =
    strength * tailRatio * Math.exp(-tailProgress * falloff);

  return tailMagnitude < 1e-5 ? 0 : tailMagnitude;
};

const getSampleBounds = (sample: DatasetSample): Bounds => ({
  minX: sample.center.x - sample.width / 2,
  maxX: sample.center.x + sample.width / 2,
  minY: sample.center.y - sample.height / 2,
  maxY: sample.center.y + sample.height / 2,
});

const clampNodeToBounds = (node: MutableNode, bounds: Bounds) => {
  node.x = clampValue(node.x, bounds.minX, bounds.maxX);
  node.y = clampValue(node.y, bounds.minY, bounds.maxY);
};

const clampMutableRoutesToBounds = (
  mutableRoutes: MutableRoute[],
  bounds: Bounds,
) => {
  for (const mutableRoute of mutableRoutes) {
    for (const node of mutableRoute.nodes) {
      clampNodeToBounds(node, bounds);
    }
  }
};

const getElementTargetClearance = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_SEGMENT_TARGET_CLEARANCE
    : POINT_SEGMENT_TARGET_CLEARANCE;

const getElementFalloffDistance = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_SEGMENT_FALLOFF_DISTANCE
    : POINT_SEGMENT_FALLOFF_DISTANCE;

const getBorderTargetClearance = (element: ForceElement) =>
  element.kind === "via" ? VIA_BORDER_TARGET_CLEARANCE : TARGET_CLEARANCE;

const getBorderFalloffDistance = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_BORDER_FALLOFF_DISTANCE
    : CLEARANCE_FALLOFF_DISTANCE;

const getBorderTailRatio = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_BORDER_REPULSION_TAIL_RATIO
    : BORDER_REPULSION_TAIL_RATIO;

const getBorderRepulsionFalloff = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_BORDER_REPULSION_FALLOFF
    : BORDER_REPULSION_FALLOFF;

const getElementIntersectionBoost = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_SEGMENT_INTERSECTION_FORCE_BOOST
    : INTERSECTION_FORCE_BOOST;

const getPointSegmentRepulsionStrength = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_SEGMENT_REPULSION_STRENGTH
    : POINT_SEGMENT_REPULSION_STRENGTH;

const getProjectionRatio = (element: ForceElement) =>
  element.kind === "via"
    ? VIA_SEGMENT_CLEARANCE_PROJECTION_RATIO
    : POINT_SEGMENT_CLEARANCE_PROJECTION_RATIO;

const getMaxCorrectionForElement = (
  element: ForceElement,
  maxCorrection: number,
) =>
  element.kind === "via"
    ? maxCorrection * VIA_SEGMENT_MAX_CLEARANCE_CORRECTION_MULTIPLIER
    : maxCorrection;

const buildMutableRoutes = (
  routes: HighDensityIntraNodeRoute[],
): MutableRoute[] =>
  routes.map((route) => {
    const nodes: MutableNode[] = [];

    for (let index = 0; index < route.route.length; index += 1) {
      const point = route.route[index];
      if (!point) continue;

      const previousPoint = route.route[index - 1];
      const lastNode = nodes.at(-1);

      if (
        lastNode &&
        previousPoint &&
        previousPoint.x === point.x &&
        previousPoint.y === point.y
      ) {
        lastNode.pointIndexes.push(index);
        continue;
      }

      nodes.push({
        x: point.x,
        y: point.y,
        originalX: point.x,
        originalY: point.y,
        pointIndexes: [index],
        fixed: index === 0 || index === route.route.length - 1,
      });
    }

    return {
      route,
      rootConnectionName: route.rootConnectionName ?? route.connectionName,
      nodes,
    };
  });

const buildForceElements = (routes: MutableRoute[]): ForceElement[] => {
  const elements: ForceElement[] = [];

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const mutableRoute = routes[routeIndex];
    if (!mutableRoute) continue;

    for (
      let nodeIndex = 0;
      nodeIndex < mutableRoute.nodes.length;
      nodeIndex += 1
    ) {
      const node = mutableRoute.nodes[nodeIndex];
      const routePointIndex = node?.pointIndexes[0];
      const routePoint =
        routePointIndex === undefined
          ? undefined
          : mutableRoute.route.route[routePointIndex];

      if (!node || !routePoint) continue;

      if (node.pointIndexes.length > 1) {
        elements.push({
          kind: "via",
          routeIndex,
          rootConnectionName: mutableRoute.rootConnectionName,
          nodeIndex,
          x: node.x,
          y: node.y,
          fixed: node.fixed,
        });
        continue;
      }

      elements.push({
        kind: "point",
        routeIndex,
        rootConnectionName: mutableRoute.rootConnectionName,
        nodeIndex,
        x: node.x,
        y: node.y,
        z: routePoint.z,
        fixed: node.fixed,
      });
    }
  }

  return elements;
};

const buildSegmentObstacles = (routes: MutableRoute[]): SegmentObstacle[] => {
  const segments: SegmentObstacle[] = [];

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const mutableRoute = routes[routeIndex];
    if (!mutableRoute) continue;

    for (
      let nodeIndex = 0;
      nodeIndex < mutableRoute.nodes.length - 1;
      nodeIndex += 1
    ) {
      const startNode = mutableRoute.nodes[nodeIndex];
      const endNode = mutableRoute.nodes[nodeIndex + 1];
      const routePointIndex = startNode?.pointIndexes[0];
      const routePoint =
        routePointIndex === undefined
          ? undefined
          : mutableRoute.route.route[routePointIndex];

      if (!startNode || !endNode || !routePoint) continue;
      if (
        Math.abs(endNode.x - startNode.x) <= POSITION_EPSILON &&
        Math.abs(endNode.y - startNode.y) <= POSITION_EPSILON
      ) {
        continue;
      }

      segments.push({
        routeIndex,
        rootConnectionName: mutableRoute.rootConnectionName,
        z: routePoint.z,
        startNodeIndex: nodeIndex,
        endNodeIndex: nodeIndex + 1,
        start: { x: startNode.x, y: startNode.y },
        end: { x: endNode.x, y: endNode.y },
      });
    }
  }

  return segments;
};

const getClosestPointOnSegment = (
  point: Vector,
  start: Vector,
  end: Vector,
): ClosestPointResult => {
  const segment = subtractVector(end, start);
  const segmentLengthSquared = dotVector(segment, segment);

  if (segmentLengthSquared <= POSITION_EPSILON) {
    const distance = getVectorMagnitude(subtractVector(point, start));
    return {
      point: start,
      t: 0,
      distance,
    };
  }

  const t = clampUnitInterval(
    dotVector(subtractVector(point, start), segment) / segmentLengthSquared,
  );
  const closestPoint = lerpVector(start, end, t);

  return {
    point: closestPoint,
    t,
    distance: getVectorMagnitude(subtractVector(point, closestPoint)),
  };
};

const getPointSegmentFallbackDirection = (
  segment: SegmentObstacle,
  fallbackSeed: number,
) =>
  getPerpendicularVector(
    subtractVector(segment.end, segment.start),
    fallbackSeed,
  );

const getViaViaInteraction = (
  leftVia: ViaForceElement,
  rightVia: ViaForceElement,
  fallbackSeed: number,
) => ({
  direction: normalizeVector(subtractVector(leftVia, rightVia), fallbackSeed),
  distance: getVectorMagnitude(subtractVector(leftVia, rightVia)),
});

const getPointSegmentInteraction = (
  point: Vector,
  segment: SegmentObstacle,
  fallbackSeed: number,
) => {
  const closest = getClosestPointOnSegment(point, segment.start, segment.end);
  const separationVector = subtractVector(point, closest.point);

  return {
    segmentT: closest.t,
    direction:
      getVectorMagnitude(separationVector) > POSITION_EPSILON
        ? normalizeVector(separationVector, fallbackSeed)
        : getPointSegmentFallbackDirection(segment, fallbackSeed),
    distance: closest.distance,
  };
};

const addForceToNode = (
  nodeForces: Vector[][],
  routeIndex: number,
  nodeIndex: number,
  force: Vector,
) => {
  const routeForces = nodeForces[routeIndex];
  if (!routeForces) return;

  routeForces[nodeIndex] = addVector(
    routeForces[nodeIndex] ?? { x: 0, y: 0 },
    force,
  );
};

const applyForceToElement = (
  element: ForceElement,
  force: Vector,
  nodeForces: Vector[][],
  elementForces?: Vector[],
  elementIndex?: number,
) => {
  if (!element.fixed) {
    addForceToNode(nodeForces, element.routeIndex, element.nodeIndex, force);
  }

  if (!element.fixed && elementForces && elementIndex !== undefined) {
    elementForces[elementIndex] = addVector(
      elementForces[elementIndex] ?? { x: 0, y: 0 },
      force,
    );
  }
};

const distributeForceToSegmentPoints = (
  mutableRoutes: MutableRoute[],
  segment: SegmentObstacle,
  force: Vector,
  nodeForces: Vector[][],
  segmentT = 0.5,
) => {
  const mutableRoute = mutableRoutes[segment.routeIndex];
  if (!mutableRoute) return;

  const startNode = mutableRoute.nodes[segment.startNodeIndex];
  const endNode = mutableRoute.nodes[segment.endNodeIndex];
  if (!startNode || !endNode) return;

  const startWeight = 1 - clampUnitInterval(segmentT);
  const endWeight = clampUnitInterval(segmentT);
  const movableStartWeight = startNode.fixed ? 0 : startWeight;
  const movableEndWeight = endNode.fixed ? 0 : endWeight;
  const movableWeightTotal = movableStartWeight + movableEndWeight;

  if (movableWeightTotal <= POSITION_EPSILON) {
    return;
  }

  if (!startNode.fixed && movableStartWeight > 0) {
    addForceToNode(
      nodeForces,
      segment.routeIndex,
      segment.startNodeIndex,
      scaleVector(force, movableStartWeight / movableWeightTotal),
    );
  }

  if (!endNode.fixed && movableEndWeight > 0) {
    addForceToNode(
      nodeForces,
      segment.routeIndex,
      segment.endNodeIndex,
      scaleVector(force, movableEndWeight / movableWeightTotal),
    );
  }
};

const getBorderForce = (
  sample: DatasetSample,
  element: ForceElement,
  stepDecay: number,
): Vector => {
  if (element.fixed) {
    return { x: 0, y: 0 };
  }

  const { minX, maxX, minY, maxY } = getSampleBounds(sample);
  const targetClearance = getBorderTargetClearance(element);
  const falloffDistance = getBorderFalloffDistance(element);
  const tailRatio = getBorderTailRatio(element);
  const borderRepulsionFalloff = getBorderRepulsionFalloff(element);
  const intersectionBoost = getElementIntersectionBoost(element);

  return {
    x:
      getClearanceForceMagnitude(
        element.x - minX,
        BORDER_REPULSION_STRENGTH,
        tailRatio,
        borderRepulsionFalloff,
        intersectionBoost,
        targetClearance,
        falloffDistance,
      ) *
        stepDecay -
      getClearanceForceMagnitude(
        maxX - element.x,
        BORDER_REPULSION_STRENGTH,
        tailRatio,
        borderRepulsionFalloff,
        intersectionBoost,
        targetClearance,
        falloffDistance,
      ) *
        stepDecay,
    y:
      getClearanceForceMagnitude(
        element.y - minY,
        BORDER_REPULSION_STRENGTH,
        tailRatio,
        borderRepulsionFalloff,
        intersectionBoost,
        targetClearance,
        falloffDistance,
      ) *
        stepDecay -
      getClearanceForceMagnitude(
        maxY - element.y,
        BORDER_REPULSION_STRENGTH,
        tailRatio,
        borderRepulsionFalloff,
        intersectionBoost,
        targetClearance,
        falloffDistance,
      ) *
        stepDecay,
  };
};

const deriveVias = (route: HighDensityIntraNodeRoute) => {
  const vias: HighDensityIntraNodeRoute["vias"] = [];

  for (let index = 0; index < route.route.length - 1; index += 1) {
    const current = route.route[index];
    const next = route.route[index + 1];
    if (!current || !next) continue;

    if (current.z === next.z) continue;
    if (
      Math.abs(current.x - next.x) > POSITION_EPSILON ||
      Math.abs(current.y - next.y) > POSITION_EPSILON
    ) {
      continue;
    }

    const lastVia = vias.at(-1);
    const nextVia = {
      x: roundCoordinate(current.x),
      y: roundCoordinate(current.y),
    };
    if (lastVia && lastVia.x === nextVia.x && lastVia.y === nextVia.y) {
      continue;
    }

    vias.push(nextVia);
  }

  return vias;
};

const materializeRoutes = (mutableRoutes: MutableRoute[]) =>
  mutableRoutes.map(({ route, nodes }) => {
    const nextRoutePoints = route.route.map((point, pointIndex) => {
      const ownerNode = nodes.find((node) =>
        node.pointIndexes.includes(pointIndex),
      );

      return ownerNode
        ? {
            ...point,
            x: roundCoordinate(ownerNode.x),
            y: roundCoordinate(ownerNode.y),
          }
        : point;
    });

    const nextRoute: HighDensityIntraNodeRoute = {
      ...route,
      route: nextRoutePoints,
      vias: [],
    };

    nextRoute.vias = deriveVias(nextRoute);
    return nextRoute;
  });

const resolveClearanceConstraints = (
  bounds: Bounds,
  mutableRoutes: MutableRoute[],
  passCount = CLEARANCE_PROJECTION_PASSES,
  maxCorrection = MAX_CLEARANCE_CORRECTION,
) => {
  for (let passIndex = 0; passIndex < passCount; passIndex += 1) {
    const forceElements = buildForceElements(mutableRoutes);
    const segments = buildSegmentObstacles(mutableRoutes);
    const nodeCorrections = mutableRoutes.map((mutableRoute) =>
      mutableRoute.nodes.map(() => ({ x: 0, y: 0 })),
    );

    for (let leftIndex = 0; leftIndex < forceElements.length; leftIndex += 1) {
      const leftElement = forceElements[leftIndex];
      if (!leftElement || leftElement.kind !== "via") continue;

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < forceElements.length;
        rightIndex += 1
      ) {
        const rightElement = forceElements[rightIndex];
        if (!rightElement || rightElement.kind !== "via") continue;
        if (leftElement.rootConnectionName === rightElement.rootConnectionName) {
          continue;
        }

        const interaction = getViaViaInteraction(
          leftElement,
          rightElement,
          passIndex * 1_009 + leftIndex * 97 + rightIndex * 13,
        );
        const penetration = TARGET_CLEARANCE - interaction.distance;
        if (penetration <= 0) continue;

        const magnitude = Math.min(
          maxCorrection,
          penetration * CLEARANCE_PROJECTION_RATIO,
        );
        const leftCorrection = scaleVector(interaction.direction, magnitude);
        const rightCorrection = scaleVector(leftCorrection, -1);

        applyForceToElement(leftElement, leftCorrection, nodeCorrections);
        applyForceToElement(rightElement, rightCorrection, nodeCorrections);
      }
    }

    for (
      let elementIndex = 0;
      elementIndex < forceElements.length;
      elementIndex += 1
    ) {
      const element = forceElements[elementIndex];
      if (!element) continue;

      for (
        let segmentIndex = 0;
        segmentIndex < segments.length;
        segmentIndex += 1
      ) {
        const segment = segments[segmentIndex];
        if (!segment) continue;
        if (element.rootConnectionName === segment.rootConnectionName) {
          continue;
        }
        if (element.kind === "point" && element.z !== segment.z) {
          continue;
        }

        const interaction = getPointSegmentInteraction(
          element,
          segment,
          passIndex * 1_009 + elementIndex * 97 + segmentIndex * 13,
        );
        const penetration =
          getElementTargetClearance(element) - interaction.distance;
        if (penetration <= 0) continue;

        const magnitude = Math.min(
          getMaxCorrectionForElement(element, maxCorrection),
          penetration * getProjectionRatio(element),
        );
        const pointCorrection = scaleVector(interaction.direction, magnitude);
        const segmentCorrection = scaleVector(pointCorrection, -1);

        applyForceToElement(element, pointCorrection, nodeCorrections);
        distributeForceToSegmentPoints(
          mutableRoutes,
          segment,
          segmentCorrection,
          nodeCorrections,
          interaction.segmentT,
        );
      }
    }

    for (let routeIndex = 0; routeIndex < mutableRoutes.length; routeIndex += 1) {
      const mutableRoute = mutableRoutes[routeIndex];
      const routeCorrections = nodeCorrections[routeIndex];
      if (!mutableRoute || !routeCorrections) continue;

      for (
        let nodeIndex = 0;
        nodeIndex < mutableRoute.nodes.length;
        nodeIndex += 1
      ) {
        const node = mutableRoute.nodes[nodeIndex];
        if (!node || node.fixed) continue;

        const correction = clampVectorMagnitude(
          routeCorrections[nodeIndex] ?? { x: 0, y: 0 },
          maxCorrection,
        );

        node.x += correction.x;
        node.y += correction.y;
      }
    }

    clampMutableRoutesToBounds(mutableRoutes, bounds);
  }
};

export const runForceDirectedImprovement = (
  sample: DatasetSample,
  routes: HighDensityIntraNodeRoute[],
  totalSteps: number,
): ForceImproveResult => {
  const bounds = getSampleBounds(sample);
  const mutableRoutes = buildMutableRoutes(routes);
  clampMutableRoutesToBounds(mutableRoutes, bounds);
  let forceVectors: ForceVector[] = [];

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const progress =
      totalSteps <= 1 ? 0 : stepIndex / Math.max(totalSteps - 1, 1);
    const stepDecay = MIN_STEP_DECAY + (1 - progress) * (1 - MIN_STEP_DECAY);
    const forceElements = buildForceElements(mutableRoutes);
    const segments = buildSegmentObstacles(mutableRoutes);
    const nodeForces = mutableRoutes.map((mutableRoute) =>
      mutableRoute.nodes.map(() => ({ x: 0, y: 0 })),
    );
    const elementForces = forceElements.map(() => ({ x: 0, y: 0 }));

    for (let leftIndex = 0; leftIndex < forceElements.length; leftIndex += 1) {
      const leftElement = forceElements[leftIndex];
      if (!leftElement || leftElement.kind !== "via") continue;

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < forceElements.length;
        rightIndex += 1
      ) {
        const rightElement = forceElements[rightIndex];
        if (!rightElement || rightElement.kind !== "via") continue;
        if (leftElement.rootConnectionName === rightElement.rootConnectionName) {
          continue;
        }

        const interaction = getViaViaInteraction(
          leftElement,
          rightElement,
          leftIndex * 97 + rightIndex * 13,
        );
        const magnitude =
          getClearanceForceMagnitude(
            interaction.distance,
            VIA_VIA_REPULSION_STRENGTH,
            REPULSION_TAIL_RATIO,
            REPULSION_FALLOFF,
          ) * stepDecay;

        if (magnitude <= 0) continue;

        const leftForce = scaleVector(interaction.direction, magnitude);
        const rightForce = scaleVector(leftForce, -1);
        applyForceToElement(
          leftElement,
          leftForce,
          nodeForces,
          elementForces,
          leftIndex,
        );
        applyForceToElement(
          rightElement,
          rightForce,
          nodeForces,
          elementForces,
          rightIndex,
        );
      }
    }

    for (
      let elementIndex = 0;
      elementIndex < forceElements.length;
      elementIndex += 1
    ) {
      const element = forceElements[elementIndex];
      if (!element) continue;

      for (
        let segmentIndex = 0;
        segmentIndex < segments.length;
        segmentIndex += 1
      ) {
        const segment = segments[segmentIndex];
        if (!segment) continue;
        if (element.rootConnectionName === segment.rootConnectionName) {
          continue;
        }
        if (element.kind === "point" && element.z !== segment.z) {
          continue;
        }

        const interaction = getPointSegmentInteraction(
          element,
          segment,
          elementIndex * 97 + segmentIndex * 13,
        );
        const magnitude =
          getClearanceForceMagnitude(
            interaction.distance,
            getPointSegmentRepulsionStrength(element),
            REPULSION_TAIL_RATIO,
            REPULSION_FALLOFF,
            getElementIntersectionBoost(element),
            getElementTargetClearance(element),
            getElementFalloffDistance(element),
          ) * stepDecay;

        if (magnitude <= 0) continue;

        const pointForce = scaleVector(interaction.direction, magnitude);
        const segmentForce = scaleVector(pointForce, -1);

        applyForceToElement(
          element,
          pointForce,
          nodeForces,
          elementForces,
          elementIndex,
        );
        distributeForceToSegmentPoints(
          mutableRoutes,
          segment,
          segmentForce,
          nodeForces,
          interaction.segmentT,
        );
      }
    }

    forceVectors = forceElements.map((element, elementIndex) => {
      const borderForce = getBorderForce(sample, element, stepDecay);
      applyForceToElement(
        element,
        borderForce,
        nodeForces,
        elementForces,
        elementIndex,
      );

      return {
        kind: element.kind,
        routeIndex: element.routeIndex,
        rootConnectionName: element.rootConnectionName,
        x: element.x,
        y: element.y,
        dx: elementForces[elementIndex]?.x ?? 0,
        dy: elementForces[elementIndex]?.y ?? 0,
      };
    });

    for (let routeIndex = 0; routeIndex < mutableRoutes.length; routeIndex += 1) {
      const mutableRoute = mutableRoutes[routeIndex];
      const routeForces = nodeForces[routeIndex];
      if (!mutableRoute || !routeForces) continue;

      for (
        let nodeIndex = 0;
        nodeIndex < mutableRoute.nodes.length;
        nodeIndex += 1
      ) {
        const node = mutableRoute.nodes[nodeIndex];
        if (!node || node.fixed) continue;

        let nextForce = routeForces[nodeIndex] ?? { x: 0, y: 0 };
        nextForce = addVector(nextForce, {
          x: (node.originalX - node.x) * SHAPE_RESTORE_STRENGTH,
          y: (node.originalY - node.y) * SHAPE_RESTORE_STRENGTH,
        });

        const previousNode = mutableRoute.nodes[nodeIndex - 1];
        const nextNode = mutableRoute.nodes[nodeIndex + 1];
        if (previousNode || nextNode) {
          const referencePoints = [previousNode, nextNode].filter(
            Boolean,
          ) as MutableNode[];
          const averageReference = referencePoints.reduce(
            (total, referencePoint) => ({
              x: total.x + referencePoint.x,
              y: total.y + referencePoint.y,
            }),
            { x: 0, y: 0 },
          );

          const neighborTarget = scaleVector(
            averageReference,
            1 / referencePoints.length,
          );

          nextForce = addVector(nextForce, {
            x: (neighborTarget.x - node.x) * PATH_SMOOTHING_STRENGTH,
            y: (neighborTarget.y - node.y) * PATH_SMOOTHING_STRENGTH,
          });
        }

        const movement = clampVectorMagnitude(
          scaleVector(nextForce, STEP_SIZE * stepDecay),
          MAX_NODE_MOVE_PER_STEP * stepDecay,
        );

        node.x += movement.x;
        node.y += movement.y;
      }
    }

    clampMutableRoutesToBounds(mutableRoutes, bounds);
    resolveClearanceConstraints(bounds, mutableRoutes);
  }

  resolveClearanceConstraints(
    bounds,
    mutableRoutes,
    FINAL_CLEARANCE_PROJECTION_PASSES,
    FINAL_MAX_CLEARANCE_CORRECTION,
  );

  return {
    routes: materializeRoutes(mutableRoutes),
    forceVectors,
    stepsCompleted: totalSteps,
  };
};
