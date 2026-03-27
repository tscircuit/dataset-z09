import type { DatasetSample } from "./types";

export const computeVecRaw = (sample: DatasetSample): number[] => {
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
    vecRaw.push(Math.atan2(portPoint.y, portPoint.x));
  }

  return vecRaw;
};
