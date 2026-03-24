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
};

export type DatasetSampleWithoutMetadata = NodeWithPortPoints;
