import type { HighDensityIntraNodeRoute } from "@tscircuit/high-density-a01";

export type PortPoint = {
  connectionName: string;
  rootConnectionName?: string;
  portPointId?: string;
  x: number;
  y: number;
  z: number;
};

export type NodeWithPortPoints = {
  capacityMeshNodeId: string;
  center: { x: number; y: number };
  width: number;
  height: number;
  portPoints: PortPoint[];
  availableZ?: number[];
};

export type DatasetSample = NodeWithPortPoints & {
  solvable: boolean;
  solvedRoutes: HighDensityIntraNodeRoute[];
};

export type DatasetSampleWithoutMetadata = NodeWithPortPoints;
