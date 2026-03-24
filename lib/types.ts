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

export type Jumper = {
  route_type: "jumper";
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
  footprint: "0603" | "1206" | "1206x4_pair";
};

export type HighDensityIntraNodeRoute = {
  connectionName: string;
  rootConnectionName?: string;
  traceThickness: number;
  viaDiameter: number;
  route: Array<{
    x: number;
    y: number;
    z: number;
    insideJumperPad?: boolean;
  }>;
  vias: Array<{
    x: number;
    y: number;
  }>;
  jumpers?: Jumper[];
};

export type DatasetSample = NodeWithPortPoints & {
  solvable: boolean;
  solution: HighDensityIntraNodeRoute[] | null;
};

export type DatasetSampleWithoutMetadata = NodeWithPortPoints;
