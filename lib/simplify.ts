import type { HighDensityIntraNodeRoute } from "./types";

type RoutePoint = HighDensityIntraNodeRoute["route"][number];
type ViaPoint = HighDensityIntraNodeRoute["vias"][number];

type RouteSection = {
  z: number;
  length: number;
  points: RoutePoint[];
};

const DEFAULT_TARGET_SEGMENTS = 10;
const ROUNDING_PRECISION = 1_000;

const roundCoordinate = (value: number) =>
  Math.round(value * ROUNDING_PRECISION) / ROUNDING_PRECISION;

const copyPoint = (point: RoutePoint): RoutePoint => ({
  x: roundCoordinate(point.x),
  y: roundCoordinate(point.y),
  z: point.z,
  ...(point.insideJumperPad === undefined
    ? {}
    : { insideJumperPad: point.insideJumperPad }),
});

const isSamePosition = (left: RoutePoint, right: RoutePoint) =>
  left.x === right.x && left.y === right.y;

const isSamePoint = (left: RoutePoint, right: RoutePoint) =>
  isSamePosition(left, right) && left.z === right.z;

const getDistance = (left: RoutePoint, right: RoutePoint) =>
  Math.hypot(right.x - left.x, right.y - left.y);

const pushSectionPoint = (section: RouteSection, point: RoutePoint) => {
  const lastPoint = section.points.at(-1);
  if (lastPoint && isSamePoint(lastPoint, point)) {
    return;
  }

  section.points.push(copyPoint(point));
};

const buildRouteSections = (points: RoutePoint[]): RouteSection[] => {
  const sections: RouteSection[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (!current || !next) continue;

    if (isSamePosition(current, next)) continue;
    if (current.z !== next.z) continue;

    const segmentLength = getDistance(current, next);
    if (segmentLength === 0) continue;

    const lastSection = sections.at(-1);
    if (!lastSection || lastSection.z !== current.z) {
      sections.push({
        z: current.z,
        length: segmentLength,
        points: [copyPoint(current), copyPoint(next)],
      });
      continue;
    }

    pushSectionPoint(lastSection, current);
    pushSectionPoint(lastSection, next);
    lastSection.length += segmentLength;
  }

  return sections.filter((section) => section.points.length >= 2);
};

const allocateSegmentCounts = (
  sections: RouteSection[],
  targetSegmentCount: number,
) => {
  if (sections.length === 0) return [];

  if (sections.length >= targetSegmentCount) {
    return sections.map(() => 1);
  }

  const segmentCounts = sections.map(() => 1);
  let remainingSegments = targetSegmentCount - sections.length;
  if (remainingSegments <= 0) return segmentCounts;

  const totalLength = sections.reduce(
    (total, section) => total + section.length,
    0,
  );

  if (totalLength === 0) {
    let index = 0;
    while (remainingSegments > 0) {
      const targetIndex = index % segmentCounts.length;
      segmentCounts[targetIndex] = (segmentCounts[targetIndex] ?? 0) + 1;
      remainingSegments -= 1;
      index += 1;
    }

    return segmentCounts;
  }

  const exactExtras = sections.map(
    (section) => (section.length / totalLength) * remainingSegments,
  );

  let assignedExtras = 0;
  for (let index = 0; index < exactExtras.length; index += 1) {
    const extraSegmentCount = Math.floor(exactExtras[index] ?? 0);
    segmentCounts[index] = (segmentCounts[index] ?? 0) + extraSegmentCount;
    assignedExtras += extraSegmentCount;
  }

  const indexesByRemainder = exactExtras
    .map((value, index) => ({
      index,
      remainder: value - Math.floor(value),
      length: sections[index]?.length ?? 0,
    }))
    .sort((left, right) => {
      if (right.remainder !== left.remainder) {
        return right.remainder - left.remainder;
      }

      return right.length - left.length;
    });

  let leftoverSegments = remainingSegments - assignedExtras;
  let remainderIndex = 0;
  while (leftoverSegments > 0) {
    const targetIndex = indexesByRemainder[remainderIndex]?.index;
    if (targetIndex === undefined) break;

    segmentCounts[targetIndex] = (segmentCounts[targetIndex] ?? 0) + 1;
    leftoverSegments -= 1;
    remainderIndex += 1;
  }

  return segmentCounts;
};

const interpolateAlongSection = (
  section: RouteSection,
  targetDistance: number,
): RoutePoint => {
  if (targetDistance <= 0) {
    const firstPoint = section.points[0];
    return firstPoint ? copyPoint(firstPoint) : { x: 0, y: 0, z: section.z };
  }

  let traversedDistance = 0;

  for (let index = 0; index < section.points.length - 1; index += 1) {
    const current = section.points[index];
    const next = section.points[index + 1];
    if (!current || !next) continue;

    const segmentLength = getDistance(current, next);
    if (segmentLength === 0) continue;

    const nextTraversedDistance = traversedDistance + segmentLength;
    if (
      targetDistance <= nextTraversedDistance ||
      index === section.points.length - 2
    ) {
      const offset = Math.min(
        1,
        Math.max(0, (targetDistance - traversedDistance) / segmentLength),
      );

      return {
        x: roundCoordinate(current.x + (next.x - current.x) * offset),
        y: roundCoordinate(current.y + (next.y - current.y) * offset),
        z: section.z,
      };
    }

    traversedDistance = nextTraversedDistance;
  }

  const lastPoint = section.points.at(-1);
  return lastPoint ? copyPoint(lastPoint) : { x: 0, y: 0, z: section.z };
};

const sampleSectionPoints = (
  section: RouteSection,
  segmentCount: number,
): RoutePoint[] => {
  if (segmentCount <= 1) {
    const firstPoint = section.points[0];
    const lastPoint = section.points.at(-1);

    if (!firstPoint || !lastPoint) return [];

    return [copyPoint(firstPoint), copyPoint(lastPoint)];
  }

  const sampledPoints: RoutePoint[] = [];

  for (let index = 0; index <= segmentCount; index += 1) {
    sampledPoints.push(
      interpolateAlongSection(section, (section.length * index) / segmentCount),
    );
  }

  return sampledPoints;
};

const appendPoint = (points: RoutePoint[], point: RoutePoint) => {
  const lastPoint = points.at(-1);
  if (lastPoint && isSamePoint(lastPoint, point)) return;

  points.push(copyPoint(point));
};

const appendVia = (vias: ViaPoint[], point: RoutePoint) => {
  const nextVia: ViaPoint = {
    x: roundCoordinate(point.x),
    y: roundCoordinate(point.y),
  };

  const lastVia = vias.at(-1);
  if (lastVia && lastVia.x === nextVia.x && lastVia.y === nextVia.y) return;

  vias.push(nextVia);
};

export const simplifyRoute = (
  route: HighDensityIntraNodeRoute,
  targetSegmentCount = DEFAULT_TARGET_SEGMENTS,
): HighDensityIntraNodeRoute => {
  if (route.route.length < 2 || targetSegmentCount <= 0) {
    return {
      ...route,
      route: route.route.map(copyPoint),
      vias: route.vias.map((via) => ({
        x: roundCoordinate(via.x),
        y: roundCoordinate(via.y),
      })),
    };
  }

  const sections = buildRouteSections(route.route);
  if (sections.length === 0) {
    return {
      ...route,
      route: route.route.map(copyPoint),
      vias: route.vias.map((via) => ({
        x: roundCoordinate(via.x),
        y: roundCoordinate(via.y),
      })),
    };
  }

  const segmentCounts = allocateSegmentCounts(sections, targetSegmentCount);
  const sampledSections = sections.map((section, index) =>
    sampleSectionPoints(section, segmentCounts[index] ?? 1),
  );

  const simplifiedPoints: RoutePoint[] = [];
  const simplifiedVias: ViaPoint[] = [];

  for (let index = 0; index < sampledSections.length; index += 1) {
    const sectionPoints = sampledSections[index];
    if (!sectionPoints || sectionPoints.length === 0) continue;

    if (index === 0) {
      for (const point of sectionPoints) {
        appendPoint(simplifiedPoints, point);
      }
      continue;
    }

    const firstPoint = sectionPoints[0];
    const lastPoint = simplifiedPoints.at(-1);
    if (!firstPoint || !lastPoint) continue;

    if (!isSamePosition(lastPoint, firstPoint)) {
      appendPoint(simplifiedPoints, {
        x: firstPoint.x,
        y: firstPoint.y,
        z: lastPoint.z,
      });
    }

    if (lastPoint.z !== firstPoint.z) {
      appendVia(simplifiedVias, firstPoint);
      appendPoint(simplifiedPoints, {
        x: firstPoint.x,
        y: firstPoint.y,
        z: firstPoint.z,
      });
    }

    for (const point of sectionPoints.slice(1)) {
      appendPoint(simplifiedPoints, point);
    }
  }

  return {
    ...route,
    route: simplifiedPoints,
    vias: simplifiedVias,
  };
};

export const simplifyRoutes = (
  routes: HighDensityIntraNodeRoute[],
  targetSegmentCount = DEFAULT_TARGET_SEGMENTS,
) => routes.map((route) => simplifyRoute(route, targetSegmentCount));
