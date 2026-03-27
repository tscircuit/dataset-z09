import type { DatasetSample } from "./types";

export const VEC_RAW_VERSION = 2;

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

  const vecRaw = [sample.width / sample.height];

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
