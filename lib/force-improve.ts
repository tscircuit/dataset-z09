import type { DatasetSample, HighDensityIntraNodeRoute } from "./types";

type RoutePoint = HighDensityIntraNodeRoute["route"][number];

type Vector = {
  x: number;
  y: number;
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
  x: number;
  y: number;
};

type SegmentForceElement = ForceElementBase & {
  kind: "segment";
  z: number;
  startNodeIndex: number;
  endNodeIndex: number;
  start: Vector;
  end: Vector;
};

type ViaForceElement = ForceElementBase & {
  kind: "via";
  nodeIndex: number;
};

type ForceElement = SegmentForceElement | ViaForceElement;

type ClosestPointResult = {
  point: Vector;
  t: number;
  distance: number;
};

type ClosestSegmentPairResult = {
  leftPoint: Vector;
  rightPoint: Vector;
  leftT: number;
  rightT: number;
  distance: number;
};

type ElementForceApplication = {
  force: Vector;
  t?: number;
};

export type ForceVector = {
  kind: "segment" | "via";
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

export const TARGET_CLEARANCE = 0.1;
export const VIA_VIA_REPULSION_STRENGTH = 0.034;
export const VIA_SEGMENT_REPULSION_STRENGTH = 0.05;
export const SEGMENT_SEGMENT_REPULSION_STRENGTH = 0.044;
export const REPULSION_TAIL_RATIO = 0.08;
export const REPULSION_FALLOFF = 18;
export const INTERSECTION_FORCE_BOOST = 3.5;
export const BORDER_REPULSION_STRENGTH = 0.03;
export const BORDER_REPULSION_TAIL_RATIO = 0.08;
export const BORDER_REPULSION_FALLOFF = 20;
export const SHAPE_RESTORE_STRENGTH = 0.14;
export const PATH_SMOOTHING_STRENGTH = 0.22;
export const CLEARANCE_PROJECTION_RATIO = 0.9;
export const CLEARANCE_PROJECTION_PASSES = 3;
export const MAX_CLEARANCE_CORRECTION = 0.02;
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
) => {
  const clampedDistance = Math.max(distance, 0);
  const normalizedDistance = clampedDistance / TARGET_CLEARANCE;

  if (normalizedDistance < 1) {
    const penetration = 1 - normalizedDistance;
    return (
      strength *
      Math.pow(penetration, 3) *
      (1 + penetration * INTERSECTION_FORCE_BOOST)
    );
  }

  const tailMagnitude =
    strength * tailRatio * Math.exp(-(normalizedDistance - 1) * falloff);

  return tailMagnitude < 1e-5 ? 0 : tailMagnitude;
};

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
      if (!node) continue;

      if (node.pointIndexes.length > 1) {
        elements.push({
          kind: "via",
          routeIndex,
          rootConnectionName: mutableRoute.rootConnectionName,
          nodeIndex,
          x: node.x,
          y: node.y,
        });
      }

      const nextNode = mutableRoute.nodes[nodeIndex + 1];
      const routePointIndex = node.pointIndexes[0];
      const routePoint = routePointIndex === undefined
        ? undefined
        : mutableRoute.route.route[routePointIndex];

      if (!nextNode || !routePoint) continue;
      if (
        Math.abs(nextNode.x - node.x) <= POSITION_EPSILON &&
        Math.abs(nextNode.y - node.y) <= POSITION_EPSILON
      ) {
        continue;
      }

      elements.push({
        kind: "segment",
        routeIndex,
        rootConnectionName: mutableRoute.rootConnectionName,
        z: routePoint.z,
        startNodeIndex: nodeIndex,
        endNodeIndex: nodeIndex + 1,
        start: { x: node.x, y: node.y },
        end: { x: nextNode.x, y: nextNode.y },
        x: (node.x + nextNode.x) / 2,
        y: (node.y + nextNode.y) / 2,
      });
    }
  }

  return elements;
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

const getClosestPointsBetweenSegments = (
  leftStart: Vector,
  leftEnd: Vector,
  rightStart: Vector,
  rightEnd: Vector,
): ClosestSegmentPairResult => {
  const leftDirection = subtractVector(leftEnd, leftStart);
  const rightDirection = subtractVector(rightEnd, rightStart);
  const betweenStarts = subtractVector(leftStart, rightStart);
  const leftLengthSquared = dotVector(leftDirection, leftDirection);
  const rightLengthSquared = dotVector(rightDirection, rightDirection);

  if (
    leftLengthSquared <= POSITION_EPSILON &&
    rightLengthSquared <= POSITION_EPSILON
  ) {
    return {
      leftPoint: leftStart,
      rightPoint: rightStart,
      leftT: 0,
      rightT: 0,
      distance: getVectorMagnitude(subtractVector(leftStart, rightStart)),
    };
  }

  if (leftLengthSquared <= POSITION_EPSILON) {
    const closest = getClosestPointOnSegment(leftStart, rightStart, rightEnd);
    return {
      leftPoint: leftStart,
      rightPoint: closest.point,
      leftT: 0,
      rightT: closest.t,
      distance: closest.distance,
    };
  }

  if (rightLengthSquared <= POSITION_EPSILON) {
    const closest = getClosestPointOnSegment(rightStart, leftStart, leftEnd);
    return {
      leftPoint: closest.point,
      rightPoint: rightStart,
      leftT: closest.t,
      rightT: 0,
      distance: closest.distance,
    };
  }

  const uv = dotVector(leftDirection, rightDirection);
  const leftBetween = dotVector(leftDirection, betweenStarts);
  const rightBetween = dotVector(rightDirection, betweenStarts);
  const denominator = leftLengthSquared * rightLengthSquared - uv * uv;

  let leftNumerator = 0;
  let leftDenominator = denominator;
  let rightNumerator = 0;
  let rightDenominator = denominator;

  if (denominator <= POSITION_EPSILON) {
    leftNumerator = 0;
    leftDenominator = 1;
    rightNumerator = rightBetween;
    rightDenominator = rightLengthSquared;
  } else {
    leftNumerator = uv * rightBetween - rightLengthSquared * leftBetween;
    rightNumerator = leftLengthSquared * rightBetween - uv * leftBetween;

    if (leftNumerator < 0) {
      leftNumerator = 0;
      rightNumerator = rightBetween;
      rightDenominator = rightLengthSquared;
    } else if (leftNumerator > leftDenominator) {
      leftNumerator = leftDenominator;
      rightNumerator = rightBetween + uv;
      rightDenominator = rightLengthSquared;
    }
  }

  if (rightNumerator < 0) {
    rightNumerator = 0;

    if (-leftBetween < 0) {
      leftNumerator = 0;
    } else if (-leftBetween > leftLengthSquared) {
      leftNumerator = leftDenominator;
    } else {
      leftNumerator = -leftBetween;
      leftDenominator = leftLengthSquared;
    }
  } else if (rightNumerator > rightDenominator) {
    rightNumerator = rightDenominator;

    if (-leftBetween + uv < 0) {
      leftNumerator = 0;
    } else if (-leftBetween + uv > leftLengthSquared) {
      leftNumerator = leftDenominator;
    } else {
      leftNumerator = -leftBetween + uv;
      leftDenominator = leftLengthSquared;
    }
  }

  const leftT =
    Math.abs(leftNumerator) <= POSITION_EPSILON
      ? 0
      : clampUnitInterval(leftNumerator / leftDenominator);
  const rightT =
    Math.abs(rightNumerator) <= POSITION_EPSILON
      ? 0
      : clampUnitInterval(rightNumerator / rightDenominator);

  const leftPoint = lerpVector(leftStart, leftEnd, leftT);
  const rightPoint = lerpVector(rightStart, rightEnd, rightT);

  return {
    leftPoint,
    rightPoint,
    leftT,
    rightT,
    distance: getVectorMagnitude(subtractVector(leftPoint, rightPoint)),
  };
};

const getSegmentFallbackDirection = (
  leftSegment: SegmentForceElement,
  rightSegment: SegmentForceElement,
  fallbackSeed: number,
) => {
  const midpointDelta = subtractVector(leftSegment, rightSegment);
  if (getVectorMagnitude(midpointDelta) > POSITION_EPSILON) {
    return normalizeVector(midpointDelta, fallbackSeed);
  }

  const leftDirection = subtractVector(leftSegment.end, leftSegment.start);
  const rightDirection = subtractVector(rightSegment.end, rightSegment.start);

  return getPerpendicularVector(
    getVectorMagnitude(leftDirection) >= getVectorMagnitude(rightDirection)
      ? leftDirection
      : rightDirection,
    fallbackSeed,
  );
};

const getViaSegmentFallbackDirection = (
  segment: SegmentForceElement,
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

const getViaSegmentInteraction = (
  via: ViaForceElement,
  segment: SegmentForceElement,
  fallbackSeed: number,
) => {
  const closest = getClosestPointOnSegment(via, segment.start, segment.end);
  const separationVector = subtractVector(via, closest.point);

  return {
    segmentT: closest.t,
    direction:
      getVectorMagnitude(separationVector) > POSITION_EPSILON
        ? normalizeVector(separationVector, fallbackSeed)
        : getViaSegmentFallbackDirection(segment, fallbackSeed),
    distance: closest.distance,
  };
};

const getSegmentSegmentInteraction = (
  leftSegment: SegmentForceElement,
  rightSegment: SegmentForceElement,
  fallbackSeed: number,
) => {
  const closest = getClosestPointsBetweenSegments(
    leftSegment.start,
    leftSegment.end,
    rightSegment.start,
    rightSegment.end,
  );
  const separationVector = subtractVector(
    closest.leftPoint,
    closest.rightPoint,
  );

  return {
    leftT: closest.leftT,
    rightT: closest.rightT,
    direction:
      getVectorMagnitude(separationVector) > POSITION_EPSILON
        ? normalizeVector(separationVector, fallbackSeed)
        : getSegmentFallbackDirection(leftSegment, rightSegment, fallbackSeed),
    distance: closest.distance,
  };
};

const getBorderForce = (
  sample: DatasetSample,
  element: ForceElement,
  stepDecay: number,
): Vector => {
  const minX = sample.center.x - sample.width / 2;
  const maxX = sample.center.x + sample.width / 2;
  const minY = sample.center.y - sample.height / 2;
  const maxY = sample.center.y + sample.height / 2;

  const leftDistance =
    element.kind === "segment"
      ? Math.min(element.start.x, element.end.x) - minX
      : element.x - minX;
  const rightDistance =
    element.kind === "segment"
      ? maxX - Math.max(element.start.x, element.end.x)
      : maxX - element.x;
  const bottomDistance =
    element.kind === "segment"
      ? Math.min(element.start.y, element.end.y) - minY
      : element.y - minY;
  const topDistance =
    element.kind === "segment"
      ? maxY - Math.max(element.start.y, element.end.y)
      : maxY - element.y;

  return {
    x:
      getClearanceForceMagnitude(
        leftDistance,
        BORDER_REPULSION_STRENGTH,
        BORDER_REPULSION_TAIL_RATIO,
        BORDER_REPULSION_FALLOFF,
      ) *
        stepDecay -
      getClearanceForceMagnitude(
        rightDistance,
        BORDER_REPULSION_STRENGTH,
        BORDER_REPULSION_TAIL_RATIO,
        BORDER_REPULSION_FALLOFF,
      ) *
        stepDecay,
    y:
      getClearanceForceMagnitude(
        bottomDistance,
        BORDER_REPULSION_STRENGTH,
        BORDER_REPULSION_TAIL_RATIO,
        BORDER_REPULSION_FALLOFF,
      ) *
        stepDecay -
      getClearanceForceMagnitude(
        topDistance,
        BORDER_REPULSION_STRENGTH,
        BORDER_REPULSION_TAIL_RATIO,
        BORDER_REPULSION_FALLOFF,
      ) *
        stepDecay,
  };
};

const distributeElementForceToNodes = (
  mutableRoutes: MutableRoute[],
  element: ForceElement,
  force: Vector,
  nodeForces: Vector[][],
  segmentT = 0.5,
) => {
  const routeForces = nodeForces[element.routeIndex];
  const mutableRoute = mutableRoutes[element.routeIndex];
  if (!routeForces || !mutableRoute) return;

  if (element.kind === "via") {
    const node = mutableRoute.nodes[element.nodeIndex];
    if (!node || node.fixed) return;

    routeForces[element.nodeIndex] = addVector(
      routeForces[element.nodeIndex] ?? { x: 0, y: 0 },
      force,
    );
    return;
  }

  const startNode = mutableRoute.nodes[element.startNodeIndex];
  const endNode = mutableRoute.nodes[element.endNodeIndex];
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
    routeForces[element.startNodeIndex] = addVector(
      routeForces[element.startNodeIndex] ?? { x: 0, y: 0 },
      scaleVector(force, movableStartWeight / movableWeightTotal),
    );
  }

  if (!endNode.fixed && movableEndWeight > 0) {
    routeForces[element.endNodeIndex] = addVector(
      routeForces[element.endNodeIndex] ?? { x: 0, y: 0 },
      scaleVector(force, movableEndWeight / movableWeightTotal),
    );
  }
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

const applyElementForce = (
  mutableRoutes: MutableRoute[],
  nodeForces: Vector[][],
  elementForces: Vector[],
  elementIndex: number,
  element: ForceElement,
  application: ElementForceApplication,
) => {
  elementForces[elementIndex] = addVector(
    elementForces[elementIndex] ?? { x: 0, y: 0 },
    application.force,
  );
  distributeElementForceToNodes(
    mutableRoutes,
    element,
    application.force,
    nodeForces,
    application.t,
  );
};

const resolveClearanceConstraints = (
  mutableRoutes: MutableRoute[],
  passCount = CLEARANCE_PROJECTION_PASSES,
  maxCorrection = MAX_CLEARANCE_CORRECTION,
) => {
  for (let passIndex = 0; passIndex < passCount; passIndex += 1) {
    const forceElements = buildForceElements(mutableRoutes);
    const nodeCorrections = mutableRoutes.map((mutableRoute) =>
      mutableRoute.nodes.map(() => ({ x: 0, y: 0 })),
    );

    for (let leftIndex = 0; leftIndex < forceElements.length; leftIndex += 1) {
      const leftElement = forceElements[leftIndex];
      if (!leftElement) continue;

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < forceElements.length;
        rightIndex += 1
      ) {
        const rightElement = forceElements[rightIndex];
        if (!rightElement) continue;
        if (leftElement.rootConnectionName === rightElement.rootConnectionName) {
          continue;
        }

        const fallbackSeed = passIndex * 1_009 + leftIndex * 97 + rightIndex * 13;

        if (leftElement.kind === "via" && rightElement.kind === "via") {
          const interaction = getViaViaInteraction(
            leftElement,
            rightElement,
            fallbackSeed,
          );
          const penetration = TARGET_CLEARANCE - interaction.distance;
          if (penetration <= 0) continue;

          const magnitude = Math.min(
            maxCorrection,
            penetration * CLEARANCE_PROJECTION_RATIO,
          );
          const leftCorrection = scaleVector(interaction.direction, magnitude);
          const rightCorrection = scaleVector(leftCorrection, -1);
          distributeElementForceToNodes(
            mutableRoutes,
            leftElement,
            leftCorrection,
            nodeCorrections,
          );
          distributeElementForceToNodes(
            mutableRoutes,
            rightElement,
            rightCorrection,
            nodeCorrections,
          );
          continue;
        }

        if (leftElement.kind === "via" && rightElement.kind === "segment") {
          const interaction = getViaSegmentInteraction(
            leftElement,
            rightElement,
            fallbackSeed,
          );
          const penetration = TARGET_CLEARANCE - interaction.distance;
          if (penetration <= 0) continue;

          const magnitude = Math.min(
            maxCorrection,
            penetration * CLEARANCE_PROJECTION_RATIO,
          );
          const viaCorrection = scaleVector(interaction.direction, magnitude);
          const segmentCorrection = scaleVector(viaCorrection, -1);
          distributeElementForceToNodes(
            mutableRoutes,
            leftElement,
            viaCorrection,
            nodeCorrections,
          );
          distributeElementForceToNodes(
            mutableRoutes,
            rightElement,
            segmentCorrection,
            nodeCorrections,
            interaction.segmentT,
          );
          continue;
        }

        if (leftElement.kind === "segment" && rightElement.kind === "via") {
          const interaction = getViaSegmentInteraction(
            rightElement,
            leftElement,
            fallbackSeed,
          );
          const penetration = TARGET_CLEARANCE - interaction.distance;
          if (penetration <= 0) continue;

          const magnitude = Math.min(
            maxCorrection,
            penetration * CLEARANCE_PROJECTION_RATIO,
          );
          const segmentCorrection = scaleVector(interaction.direction, magnitude);
          const viaCorrection = scaleVector(segmentCorrection, -1);
          distributeElementForceToNodes(
            mutableRoutes,
            leftElement,
            segmentCorrection,
            nodeCorrections,
            interaction.segmentT,
          );
          distributeElementForceToNodes(
            mutableRoutes,
            rightElement,
            viaCorrection,
            nodeCorrections,
          );
          continue;
        }

        if (leftElement.kind !== "segment" || rightElement.kind !== "segment") {
          continue;
        }
        if (leftElement.z !== rightElement.z) {
          continue;
        }

        const interaction = getSegmentSegmentInteraction(
          leftElement,
          rightElement,
          fallbackSeed,
        );
        const penetration = TARGET_CLEARANCE - interaction.distance;
        if (penetration <= 0) continue;

        const magnitude = Math.min(
          maxCorrection,
          penetration * CLEARANCE_PROJECTION_RATIO,
        );
        const leftCorrection = scaleVector(interaction.direction, magnitude);
        const rightCorrection = scaleVector(leftCorrection, -1);
        distributeElementForceToNodes(
          mutableRoutes,
          leftElement,
          leftCorrection,
          nodeCorrections,
          interaction.leftT,
        );
        distributeElementForceToNodes(
          mutableRoutes,
          rightElement,
          rightCorrection,
          nodeCorrections,
          interaction.rightT,
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
  }
};

export const runForceDirectedImprovement = (
  sample: DatasetSample,
  routes: HighDensityIntraNodeRoute[],
  totalSteps: number,
): ForceImproveResult => {
  const mutableRoutes = buildMutableRoutes(routes);
  let forceVectors: ForceVector[] = [];

  for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
    const progress =
      totalSteps <= 1 ? 0 : stepIndex / Math.max(totalSteps - 1, 1);
    const stepDecay = MIN_STEP_DECAY + (1 - progress) * (1 - MIN_STEP_DECAY);
    const forceElements = buildForceElements(mutableRoutes);
    const nodeForces = mutableRoutes.map((mutableRoute) =>
      mutableRoute.nodes.map(() => ({ x: 0, y: 0 })),
    );
    const elementForces = forceElements.map(() => ({ x: 0, y: 0 }));

    for (let leftIndex = 0; leftIndex < forceElements.length; leftIndex += 1) {
      const leftElement = forceElements[leftIndex];
      if (!leftElement) continue;

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < forceElements.length;
        rightIndex += 1
      ) {
        const rightElement = forceElements[rightIndex];
        if (!rightElement) continue;
        if (leftElement.rootConnectionName === rightElement.rootConnectionName) {
          continue;
        }

        const fallbackSeed = leftIndex * 97 + rightIndex * 13;

        if (leftElement.kind === "via" && rightElement.kind === "via") {
          const interaction = getViaViaInteraction(
            leftElement,
            rightElement,
            fallbackSeed,
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
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            leftIndex,
            leftElement,
            { force: leftForce },
          );
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            rightIndex,
            rightElement,
            { force: rightForce },
          );
          continue;
        }

        if (leftElement.kind === "via" && rightElement.kind === "segment") {
          const interaction = getViaSegmentInteraction(
            leftElement,
            rightElement,
            fallbackSeed,
          );
          const magnitude =
            getClearanceForceMagnitude(
              interaction.distance,
              VIA_SEGMENT_REPULSION_STRENGTH,
              REPULSION_TAIL_RATIO,
              REPULSION_FALLOFF,
            ) * stepDecay;

          if (magnitude <= 0) continue;

          const viaForce = scaleVector(interaction.direction, magnitude);
          const segmentForce = scaleVector(viaForce, -1);
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            leftIndex,
            leftElement,
            { force: viaForce },
          );
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            rightIndex,
            rightElement,
            { force: segmentForce, t: interaction.segmentT },
          );
          continue;
        }

        if (leftElement.kind === "segment" && rightElement.kind === "via") {
          const interaction = getViaSegmentInteraction(
            rightElement,
            leftElement,
            fallbackSeed,
          );
          const magnitude =
            getClearanceForceMagnitude(
              interaction.distance,
              VIA_SEGMENT_REPULSION_STRENGTH,
              REPULSION_TAIL_RATIO,
              REPULSION_FALLOFF,
            ) * stepDecay;

          if (magnitude <= 0) continue;

          const segmentForce = scaleVector(interaction.direction, magnitude);
          const viaForce = scaleVector(segmentForce, -1);
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            leftIndex,
            leftElement,
            { force: segmentForce, t: interaction.segmentT },
          );
          applyElementForce(
            mutableRoutes,
            nodeForces,
            elementForces,
            rightIndex,
            rightElement,
            { force: viaForce },
          );
          continue;
        }

        if (leftElement.kind !== "segment" || rightElement.kind !== "segment") {
          continue;
        }
        if (leftElement.z !== rightElement.z) {
          continue;
        }

        const interaction = getSegmentSegmentInteraction(
          leftElement,
          rightElement,
          fallbackSeed,
        );
        const magnitude =
          getClearanceForceMagnitude(
            interaction.distance,
            SEGMENT_SEGMENT_REPULSION_STRENGTH,
            REPULSION_TAIL_RATIO,
            REPULSION_FALLOFF,
          ) * stepDecay;

        if (magnitude <= 0) continue;

        const leftForce = scaleVector(interaction.direction, magnitude);
        const rightForce = scaleVector(leftForce, -1);
        applyElementForce(
          mutableRoutes,
          nodeForces,
          elementForces,
          leftIndex,
          leftElement,
          { force: leftForce, t: interaction.leftT },
        );
        applyElementForce(
          mutableRoutes,
          nodeForces,
          elementForces,
          rightIndex,
          rightElement,
          { force: rightForce, t: interaction.rightT },
        );
      }
    }

    forceVectors = forceElements.map((element, elementIndex) => {
      const borderForce = getBorderForce(sample, element, stepDecay);
      elementForces[elementIndex] = addVector(
        elementForces[elementIndex] ?? { x: 0, y: 0 },
        borderForce,
      );
      distributeElementForceToNodes(
        mutableRoutes,
        element,
        borderForce,
        nodeForces,
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

    resolveClearanceConstraints(mutableRoutes);
  }

  resolveClearanceConstraints(
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
