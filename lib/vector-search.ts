export type SampleRawVecIndexEntry = {
  fileName: string;
  vecRaw: number[];
};

type RawVecPoint = {
  angle: number;
  z: number;
  x: number;
  y: number;
};

type RawVecPair = [RawVecPoint, RawVecPoint];

const VECTOR_MAGNITUDE_EPSILON = 1e-9;
const TAU = Math.PI * 2;
const LEXICOGRAPHIC_EPSILON = 1e-9;

export const VECTOR_DISTANCE_WEIGHTS = {
  ratio: 0.25,
  z: 0.25,
  x: 0.25,
  y: 0.25,
} as const;

const normalizeAngle = (angle: number) => {
  const normalizedAngle = angle % TAU;
  return normalizedAngle < 0 ? normalizedAngle + TAU : normalizedAngle;
};

const compareRawVecPointsForSweep = (
  leftPoint: RawVecPoint,
  rightPoint: RawVecPoint,
) => {
  const leftAngle = normalizeAngle(leftPoint.angle);
  const rightAngle = normalizeAngle(rightPoint.angle);

  if (leftPoint.z !== rightPoint.z) {
    return leftPoint.z - rightPoint.z;
  }

  if (Math.abs(leftAngle - rightAngle) > LEXICOGRAPHIC_EPSILON) {
    return leftAngle - rightAngle;
  }

  if (Math.abs(leftPoint.x - rightPoint.x) > LEXICOGRAPHIC_EPSILON) {
    return leftPoint.x - rightPoint.x;
  }

  return leftPoint.y - rightPoint.y;
};

const compareRawVecPairsForSweep = (
  leftPair: RawVecPair,
  rightPair: RawVecPair,
) => {
  const firstPointComparison = compareRawVecPointsForSweep(
    leftPair[0],
    rightPair[0],
  );
  if (firstPointComparison !== 0) {
    return firstPointComparison;
  }

  return compareRawVecPointsForSweep(leftPair[1], rightPair[1]);
};

export const canonicalizeRawVecStructure = (vector: number[]): number[] => {
  if (vector.length <= 1 || (vector.length - 1) % 8 !== 0) {
    return [...vector];
  }

  const ratio = vector[0];
  if (ratio === undefined) {
    return [...vector];
  }

  const pairs: RawVecPair[] = [];

  for (let index = 1; index < vector.length; index += 8) {
    const firstAngle = vector[index];
    const firstZ = vector[index + 1];
    const firstX = vector[index + 2];
    const firstY = vector[index + 3];
    const secondAngle = vector[index + 4];
    const secondZ = vector[index + 5];
    const secondX = vector[index + 6];
    const secondY = vector[index + 7];

    if (
      firstAngle === undefined ||
      firstZ === undefined ||
      firstX === undefined ||
      firstY === undefined ||
      secondAngle === undefined ||
      secondZ === undefined ||
      secondX === undefined ||
      secondY === undefined
    ) {
      return [...vector];
    }

    const orderedPair = [
      {
        angle: normalizeAngle(firstAngle),
        z: firstZ,
        x: firstX,
        y: firstY,
      },
      {
        angle: normalizeAngle(secondAngle),
        z: secondZ,
        x: secondX,
        y: secondY,
      },
    ].sort(compareRawVecPointsForSweep) as RawVecPair;

    pairs.push(orderedPair);
  }

  pairs.sort(compareRawVecPairsForSweep);

  return [
    ratio,
    ...pairs.flatMap((pair) => [
      pair[0].angle,
      pair[0].z,
      pair[0].x,
      pair[0].y,
      pair[1].angle,
      pair[1].z,
      pair[1].x,
      pair[1].y,
    ]),
  ];
};

export const applyVectorWeights = (vector: number[]): number[] =>
  vector.map((value, index) => {
    if (index === 0) {
      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.ratio);
    }

    const componentIndex = (index - 1) % 4;
    if (componentIndex === 0) {
      return 0;
    }

    if (componentIndex === 1) {
      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.z);
    }

    if (componentIndex === 2) {
      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.x);
    }

    return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.y);
  });

export const canonicalizeVector = (vector: number[]): number[] => {
  const weightedVector = applyVectorWeights(
    canonicalizeRawVecStructure(vector),
  );
  const magnitude = Math.hypot(...weightedVector);
  if (magnitude <= VECTOR_MAGNITUDE_EPSILON) {
    return weightedVector.map(() => 0);
  }

  return weightedVector.map((value) => value / magnitude);
};

export const getVectorDistance = (
  leftVector: number[],
  rightVector: number[],
): number => {
  if (leftVector.length !== rightVector.length) {
    return Number.POSITIVE_INFINITY;
  }

  const left = canonicalizeRawVecStructure(leftVector);
  const right = canonicalizeRawVecStructure(rightVector);
  const ratioDelta = (left[0] ?? 0) - (right[0] ?? 0);

  let zDistance = 0;
  let xDistance = 0;
  let yDistance = 0;

  for (let index = 1; index < left.length; index += 4) {
    const leftZ = left[index + 1] ?? 0;
    const rightZ = right[index + 1] ?? 0;
    const leftX = left[index + 2] ?? 0;
    const rightX = right[index + 2] ?? 0;
    const leftY = left[index + 3] ?? 0;
    const rightY = right[index + 3] ?? 0;

    const zDelta = leftZ - rightZ;
    const xDelta = leftX - rightX;
    const yDelta = leftY - rightY;

    zDistance += zDelta * zDelta;
    xDistance += xDelta * xDelta;
    yDistance += yDelta * yDelta;
  }

  return Math.sqrt(
    ratioDelta * ratioDelta * VECTOR_DISTANCE_WEIGHTS.ratio +
      zDistance * VECTOR_DISTANCE_WEIGHTS.z +
      xDistance * VECTOR_DISTANCE_WEIGHTS.x +
      yDistance * VECTOR_DISTANCE_WEIGHTS.y,
  );
};
