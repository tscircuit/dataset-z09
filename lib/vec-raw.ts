import type { DatasetSample } from "./types";

export const VEC_RAW_VERSION = 3;

type PortPair = [DatasetSample["portPoints"][number], DatasetSample["portPoints"][number]];

const getPortPairs = (sample: DatasetSample): PortPair[] => {
  const portPointsByConnection = new Map<string, DatasetSample["portPoints"]>();

  for (const portPoint of sample.portPoints) {
    const existingPortPoints =
      portPointsByConnection.get(portPoint.connectionName) ?? [];
    existingPortPoints.push(portPoint);
    portPointsByConnection.set(portPoint.connectionName, existingPortPoints);
  }

  return [...portPointsByConnection.values()].map((portPoints) => {
    if (portPoints.length !== 2) {
      throw new Error(
        `Cannot compute vecRaw for ${sample.capacityMeshNodeId}: expected exactly 2 port points per connection, got ${portPoints.length}`,
      );
    }

    return [portPoints[0]!, portPoints[1]!];
  });
};

const getOrientation = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
) => (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);

const isPointOnSegment = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  point: { x: number; y: number },
) =>
  point.x <= Math.max(a.x, b.x) &&
  point.x >= Math.min(a.x, b.x) &&
  point.y <= Math.max(a.y, b.y) &&
  point.y >= Math.min(a.y, b.y);

const segmentsIntersect = (
  aStart: { x: number; y: number },
  aEnd: { x: number; y: number },
  bStart: { x: number; y: number },
  bEnd: { x: number; y: number },
) => {
  const orientation1 = getOrientation(aStart, aEnd, bStart);
  const orientation2 = getOrientation(aStart, aEnd, bEnd);
  const orientation3 = getOrientation(bStart, bEnd, aStart);
  const orientation4 = getOrientation(bStart, bEnd, aEnd);

  if (
    Math.sign(orientation1) !== Math.sign(orientation2) &&
    Math.sign(orientation3) !== Math.sign(orientation4)
  ) {
    return true;
  }

  if (orientation1 === 0 && isPointOnSegment(aStart, aEnd, bStart)) return true;
  if (orientation2 === 0 && isPointOnSegment(aStart, aEnd, bEnd)) return true;
  if (orientation3 === 0 && isPointOnSegment(bStart, bEnd, aStart)) return true;
  if (orientation4 === 0 && isPointOnSegment(bStart, bEnd, aEnd)) return true;

  return false;
};

const getRawVecTopologyTerms = (sample: DatasetSample) => {
  const portPairs = getPortPairs(sample);
  let sameZIntersections = 0;
  let differentZIntersections = 0;
  let entryExitZChanges = 0;

  for (const [startPoint, endPoint] of portPairs) {
    if (startPoint.z !== endPoint.z) {
      entryExitZChanges += 1;
    }
  }

  for (let leftIndex = 0; leftIndex < portPairs.length; leftIndex += 1) {
    const leftPair = portPairs[leftIndex]!;

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < portPairs.length;
      rightIndex += 1
    ) {
      const rightPair = portPairs[rightIndex]!;

      if (
        !segmentsIntersect(leftPair[0], leftPair[1], rightPair[0], rightPair[1])
      ) {
        continue;
      }

      const leftPairHasFixedZ = leftPair[0].z === leftPair[1].z;
      const rightPairHasFixedZ = rightPair[0].z === rightPair[1].z;

      if (
        leftPairHasFixedZ &&
        rightPairHasFixedZ &&
        leftPair[0].z === rightPair[0].z
      ) {
        sameZIntersections += 1;
      } else {
        differentZIntersections += 1;
      }
    }
  }

  return {
    sameZIntersections,
    differentZIntersections,
    entryExitZChanges,
  };
};

export const computeVecRaw = (sample: DatasetSample): number[] => {
  if (sample.width === 0) {
    throw new Error(
      `Cannot compute vecRaw for ${sample.capacityMeshNodeId}: width is 0`,
    );
  }

  if (sample.height === 0) {
    throw new Error(
      `Cannot compute vecRaw for ${sample.capacityMeshNodeId}: height is 0`,
    );
  }

  if (sample.portPoints.length % 2 !== 0) {
    throw new Error(
      `Cannot compute vecRaw for ${sample.capacityMeshNodeId}: expected an even number of port points, got ${sample.portPoints.length}`,
    );
  }

  const {
    sameZIntersections,
    differentZIntersections,
    entryExitZChanges,
  } = getRawVecTopologyTerms(sample);
  const vecRaw = [
    sample.width / sample.height,
    sameZIntersections,
    differentZIntersections,
    entryExitZChanges,
  ];

  for (const portPoint of sample.portPoints) {
    const relativeX = portPoint.x - sample.center.x;
    const relativeY = portPoint.y - sample.center.y;
    vecRaw.push(
      Math.atan2(relativeY, relativeX),
      portPoint.z,
      relativeX / (sample.width / 2),
      relativeY / (sample.height / 2),
    );
  }

  return vecRaw;
};
