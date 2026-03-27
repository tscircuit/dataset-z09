import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
  PortPoint,
} from "./types";

type Point2D = {
  x: number;
  y: number;
};

type Point3D = Point2D & {
  z: number;
};

type RouteSegment = {
  routeIndex: number;
  connectionName: string;
  segmentIndex: number;
  traceThickness: number;
  start: Point3D;
  end: Point3D;
};

export type DrcIssue =
  | {
      kind: "invalid-route";
      routeIndex: number;
      connectionName: string;
      message: string;
    }
  | {
      kind: "trace-trace";
      leftRouteIndex: number;
      rightRouteIndex: number;
      leftConnectionName: string;
      rightConnectionName: string;
      leftSegmentIndex: number;
      rightSegmentIndex: number;
      distance: number;
      clearance: number;
    }
  | {
      kind: "via-trace";
      viaRouteIndex: number;
      traceRouteIndex: number;
      viaConnectionName: string;
      traceConnectionName: string;
      traceSegmentIndex: number;
      distance: number;
      clearance: number;
    }
  | {
      kind: "via-via";
      leftRouteIndex: number;
      rightRouteIndex: number;
      leftConnectionName: string;
      rightConnectionName: string;
      distance: number;
      clearance: number;
    }
  | {
      kind: "out-of-bounds";
      routeIndex: number;
      connectionName: string;
      pointType: "route-point" | "via";
      pointIndex: number;
      x: number;
      y: number;
    };

export type DrcCheckResult = {
  ok: boolean;
  issues: DrcIssue[];
};

const POSITION_EPSILON = 1e-6;

const subtractPoint = (left: Point2D, right: Point2D): Point2D => ({
  x: left.x - right.x,
  y: left.y - right.y,
});

const dotPoint = (left: Point2D, right: Point2D) =>
  left.x * right.x + left.y * right.y;

const crossPoint = (left: Point2D, right: Point2D) =>
  left.x * right.y - left.y * right.x;

const getPointDistance = (left: Point2D, right: Point2D) =>
  Math.hypot(left.x - right.x, left.y - right.y);

const arePointsCoincident = (left: Point2D, right: Point2D) =>
  getPointDistance(left, right) <= POSITION_EPSILON;

const clampUnitInterval = (value: number) => Math.max(0, Math.min(value, 1));

const getDistanceFromPointToSegment = (
  point: Point2D,
  start: Point2D,
  end: Point2D,
) => {
  const delta = subtractPoint(end, start);
  const lengthSquared = dotPoint(delta, delta);

  if (lengthSquared <= POSITION_EPSILON) {
    return getPointDistance(point, start);
  }

  const t = clampUnitInterval(
    dotPoint(subtractPoint(point, start), delta) / lengthSquared,
  );
  const projection = {
    x: start.x + delta.x * t,
    y: start.y + delta.y * t,
  };

  return getPointDistance(point, projection);
};

const getOrientation = (origin: Point2D, left: Point2D, right: Point2D) =>
  crossPoint(subtractPoint(left, origin), subtractPoint(right, origin));

const isPointOnSegment = (point: Point2D, start: Point2D, end: Point2D) =>
  point.x >= Math.min(start.x, end.x) - POSITION_EPSILON &&
  point.x <= Math.max(start.x, end.x) + POSITION_EPSILON &&
  point.y >= Math.min(start.y, end.y) - POSITION_EPSILON &&
  point.y <= Math.max(start.y, end.y) + POSITION_EPSILON;

const doSegmentsIntersect = (
  leftStart: Point2D,
  leftEnd: Point2D,
  rightStart: Point2D,
  rightEnd: Point2D,
) => {
  const leftStartOrientation = getOrientation(leftStart, leftEnd, rightStart);
  const leftEndOrientation = getOrientation(leftStart, leftEnd, rightEnd);
  const rightStartOrientation = getOrientation(rightStart, rightEnd, leftStart);
  const rightEndOrientation = getOrientation(rightStart, rightEnd, leftEnd);

  if (
    Math.abs(leftStartOrientation) <= POSITION_EPSILON &&
    isPointOnSegment(rightStart, leftStart, leftEnd)
  ) {
    return true;
  }

  if (
    Math.abs(leftEndOrientation) <= POSITION_EPSILON &&
    isPointOnSegment(rightEnd, leftStart, leftEnd)
  ) {
    return true;
  }

  if (
    Math.abs(rightStartOrientation) <= POSITION_EPSILON &&
    isPointOnSegment(leftStart, rightStart, rightEnd)
  ) {
    return true;
  }

  if (
    Math.abs(rightEndOrientation) <= POSITION_EPSILON &&
    isPointOnSegment(leftEnd, rightStart, rightEnd)
  ) {
    return true;
  }

  return (
    leftStartOrientation * leftEndOrientation < 0 &&
    rightStartOrientation * rightEndOrientation < 0
  );
};

const getSegmentDistance = (
  leftStart: Point2D,
  leftEnd: Point2D,
  rightStart: Point2D,
  rightEnd: Point2D,
) => {
  if (doSegmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) {
    return 0;
  }

  return Math.min(
    getDistanceFromPointToSegment(leftStart, rightStart, rightEnd),
    getDistanceFromPointToSegment(leftEnd, rightStart, rightEnd),
    getDistanceFromPointToSegment(rightStart, leftStart, leftEnd),
    getDistanceFromPointToSegment(rightEnd, leftStart, leftEnd),
  );
};

const getNodeBounds = (nodeWithPortPoints: NodeWithPortPoints) => ({
  minX: nodeWithPortPoints.center.x - nodeWithPortPoints.width / 2,
  maxX: nodeWithPortPoints.center.x + nodeWithPortPoints.width / 2,
  minY: nodeWithPortPoints.center.y - nodeWithPortPoints.height / 2,
  maxY: nodeWithPortPoints.center.y + nodeWithPortPoints.height / 2,
});

const isPointInsideBounds = (
  point: Point2D,
  bounds: ReturnType<typeof getNodeBounds>,
) =>
  point.x >= bounds.minX - POSITION_EPSILON &&
  point.x <= bounds.maxX + POSITION_EPSILON &&
  point.y >= bounds.minY - POSITION_EPSILON &&
  point.y <= bounds.maxY + POSITION_EPSILON;

const extractRouteSegments = (
  routes: HighDensityIntraNodeRoute[],
): {
  segments: RouteSegment[];
  issues: DrcIssue[];
} => {
  const segments: RouteSegment[] = [];
  const issues: DrcIssue[] = [];

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (!route || route.route.length < 2) {
      if (route) {
        issues.push({
          kind: "invalid-route",
          routeIndex,
          connectionName: route.connectionName,
          message: "Route must contain at least 2 points.",
        });
      }
      continue;
    }

    for (
      let segmentIndex = 0;
      segmentIndex < route.route.length - 1;
      segmentIndex += 1
    ) {
      const start = route.route[segmentIndex];
      const end = route.route[segmentIndex + 1];

      if (!start || !end) continue;

      if (start.x === end.x && start.y === end.y) {
        if (start.z !== end.z) {
          continue;
        }

        continue;
      }

      if (start.z !== end.z) {
        issues.push({
          kind: "invalid-route",
          routeIndex,
          connectionName: route.connectionName,
          message: `Segment ${segmentIndex} changes z without a colocated via.`,
        });
        continue;
      }

      segments.push({
        routeIndex,
        connectionName: route.connectionName,
        segmentIndex,
        traceThickness: route.traceThickness,
        start,
        end,
      });
    }
  }

  return {
    segments,
    issues,
  };
};

const isAdjacentSegmentPair = (left: RouteSegment, right: RouteSegment) =>
  left.routeIndex === right.routeIndex &&
  Math.abs(left.segmentIndex - right.segmentIndex) <= 1;

const isViaIncidentToSegment = (
  via: Point2D,
  routeIndex: number,
  segment: RouteSegment,
) =>
  routeIndex === segment.routeIndex &&
  (arePointsCoincident(via, segment.start) ||
    arePointsCoincident(via, segment.end));

const getPortPointsByConnectionName = (
  nodeWithPortPoints: NodeWithPortPoints,
) => {
  const portPointsByConnection = new Map<string, PortPoint[]>();

  for (const portPoint of nodeWithPortPoints.portPoints) {
    const existingPortPoints =
      portPointsByConnection.get(portPoint.connectionName) ?? [];
    existingPortPoints.push(portPoint);
    portPointsByConnection.set(portPoint.connectionName, existingPortPoints);
  }

  return portPointsByConnection;
};

const isSamePoint3D = (left: Point3D, right: Point3D) =>
  arePointsCoincident(left, right) && left.z === right.z;

const getFirstMovedPointIndex = (route: HighDensityIntraNodeRoute) => {
  const startPoint = route.route[0];
  if (!startPoint) return null;

  for (let pointIndex = 1; pointIndex < route.route.length; pointIndex += 1) {
    const point = route.route[pointIndex];
    if (!point) continue;

    if (!arePointsCoincident(startPoint, point)) {
      return pointIndex;
    }
  }

  return null;
};

const getLastMovedPointIndex = (route: HighDensityIntraNodeRoute) => {
  const endPoint = route.route.at(-1);
  if (!endPoint) return null;

  for (
    let pointIndex = route.route.length - 2;
    pointIndex >= 0;
    pointIndex -= 1
  ) {
    const point = route.route[pointIndex];
    if (!point) continue;

    if (!arePointsCoincident(endPoint, point)) {
      return pointIndex;
    }
  }

  return null;
};

const isEndpointAttachedOnSameLayer = (
  route: HighDensityIntraNodeRoute,
  portPoint: PortPoint,
  endpoint: "start" | "end",
) => {
  const endpointPoint =
    endpoint === "start" ? route.route[0] : route.route.at(-1);
  if (!endpointPoint || !isSamePoint3D(endpointPoint, portPoint)) {
    return false;
  }

  const movedPointIndex =
    endpoint === "start"
      ? getFirstMovedPointIndex(route)
      : getLastMovedPointIndex(route);

  if (movedPointIndex === null) {
    return false;
  }

  const colocatedSlice =
    endpoint === "start"
      ? route.route.slice(0, movedPointIndex)
      : route.route.slice(movedPointIndex + 1);

  if (colocatedSlice.some((point) => point && point.z !== portPoint.z)) {
    return false;
  }

  const movedPoint = route.route[movedPointIndex];
  return movedPoint?.z === portPoint.z;
};

const routeHasValidAttachedEndpoints = (
  route: HighDensityIntraNodeRoute,
  portPoints: [PortPoint, PortPoint],
) =>
  (isEndpointAttachedOnSameLayer(route, portPoints[0], "start") &&
    isEndpointAttachedOnSameLayer(route, portPoints[1], "end")) ||
  (isEndpointAttachedOnSameLayer(route, portPoints[1], "start") &&
    isEndpointAttachedOnSameLayer(route, portPoints[0], "end"));

export const runDrcCheck = (
  nodeWithPortPoints: NodeWithPortPoints,
  routes: HighDensityIntraNodeRoute[],
): DrcCheckResult => {
  const issues: DrcIssue[] = [];
  const bounds = getNodeBounds(nodeWithPortPoints);
  const { segments, issues: segmentIssues } = extractRouteSegments(routes);
  const portPointsByConnection =
    getPortPointsByConnectionName(nodeWithPortPoints);

  issues.push(...segmentIssues);

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (!route) continue;

    const routePortPoints = portPointsByConnection.get(route.connectionName);
    if (!routePortPoints || routePortPoints.length !== 2) {
      issues.push({
        kind: "invalid-route",
        routeIndex,
        connectionName: route.connectionName,
        message: "Route must match exactly 2 sample port points.",
      });
      continue;
    }

    const firstPortPoint = routePortPoints[0];
    const secondPortPoint = routePortPoints[1];
    if (!firstPortPoint || !secondPortPoint) {
      issues.push({
        kind: "invalid-route",
        routeIndex,
        connectionName: route.connectionName,
        message: "Route must match exactly 2 sample port points.",
      });
      continue;
    }

    if (
      !routeHasValidAttachedEndpoints(route, [firstPortPoint, secondPortPoint])
    ) {
      issues.push({
        kind: "invalid-route",
        routeIndex,
        connectionName: route.connectionName,
        message:
          "Route endpoints must connect to both port points and leave/arrive on the same layer as the attached port.",
      });
    }

    for (let pointIndex = 0; pointIndex < route.route.length; pointIndex += 1) {
      const point = route.route[pointIndex];
      if (!point || isPointInsideBounds(point, bounds)) continue;

      issues.push({
        kind: "out-of-bounds",
        routeIndex,
        connectionName: route.connectionName,
        pointType: "route-point",
        pointIndex,
        x: point.x,
        y: point.y,
      });
    }

    for (let viaIndex = 0; viaIndex < route.vias.length; viaIndex += 1) {
      const via = route.vias[viaIndex];
      if (!via || isPointInsideBounds(via, bounds)) continue;

      issues.push({
        kind: "out-of-bounds",
        routeIndex,
        connectionName: route.connectionName,
        pointType: "via",
        pointIndex: viaIndex,
        x: via.x,
        y: via.y,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
    const leftSegment = segments[leftIndex];
    if (!leftSegment) continue;

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < segments.length;
      rightIndex += 1
    ) {
      const rightSegment = segments[rightIndex];
      if (!rightSegment || leftSegment.start.z !== rightSegment.start.z) {
        continue;
      }

      if (isAdjacentSegmentPair(leftSegment, rightSegment)) {
        continue;
      }

      const clearance =
        leftSegment.traceThickness / 2 + rightSegment.traceThickness / 2;
      const distance = getSegmentDistance(
        leftSegment.start,
        leftSegment.end,
        rightSegment.start,
        rightSegment.end,
      );

      if (distance + POSITION_EPSILON >= clearance) {
        continue;
      }

      issues.push({
        kind: "trace-trace",
        leftRouteIndex: leftSegment.routeIndex,
        rightRouteIndex: rightSegment.routeIndex,
        leftConnectionName: leftSegment.connectionName,
        rightConnectionName: rightSegment.connectionName,
        leftSegmentIndex: leftSegment.segmentIndex,
        rightSegmentIndex: rightSegment.segmentIndex,
        distance,
        clearance,
      });
    }
  }

  for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
    const route = routes[routeIndex];
    if (!route) continue;

    for (const via of route.vias) {
      const viaRadius = route.viaDiameter / 2;

      for (const segment of segments) {
        if (isViaIncidentToSegment(via, routeIndex, segment)) {
          continue;
        }

        const clearance = viaRadius + segment.traceThickness / 2;
        const distance = getDistanceFromPointToSegment(
          via,
          segment.start,
          segment.end,
        );

        if (distance + POSITION_EPSILON >= clearance) {
          continue;
        }

        issues.push({
          kind: "via-trace",
          viaRouteIndex: routeIndex,
          traceRouteIndex: segment.routeIndex,
          viaConnectionName: route.connectionName,
          traceConnectionName: segment.connectionName,
          traceSegmentIndex: segment.segmentIndex,
          distance,
          clearance,
        });
      }
    }
  }

  for (
    let leftRouteIndex = 0;
    leftRouteIndex < routes.length;
    leftRouteIndex += 1
  ) {
    const leftRoute = routes[leftRouteIndex];
    if (!leftRoute) continue;

    for (
      let leftViaIndex = 0;
      leftViaIndex < leftRoute.vias.length;
      leftViaIndex += 1
    ) {
      const leftVia = leftRoute.vias[leftViaIndex];
      if (!leftVia) continue;

      for (
        let rightRouteIndex = leftRouteIndex;
        rightRouteIndex < routes.length;
        rightRouteIndex += 1
      ) {
        const rightRoute = routes[rightRouteIndex];
        if (!rightRoute) continue;

        const rightViaStartIndex =
          rightRouteIndex === leftRouteIndex ? leftViaIndex + 1 : 0;

        for (
          let rightViaIndex = rightViaStartIndex;
          rightViaIndex < rightRoute.vias.length;
          rightViaIndex += 1
        ) {
          const rightVia = rightRoute.vias[rightViaIndex];
          if (!rightVia) continue;

          const clearance =
            leftRoute.viaDiameter / 2 + rightRoute.viaDiameter / 2;
          const distance = getPointDistance(leftVia, rightVia);

          if (distance + POSITION_EPSILON >= clearance) {
            continue;
          }

          issues.push({
            kind: "via-via",
            leftRouteIndex,
            rightRouteIndex,
            leftConnectionName: leftRoute.connectionName,
            rightConnectionName: rightRoute.connectionName,
            distance,
            clearance,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
};
