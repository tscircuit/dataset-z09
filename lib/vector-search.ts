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
const LEGACY_RAW_VEC_HEADER_LENGTH = 1;
const RAW_VEC_HEADER_LENGTH = 4;
const RAW_VEC_PAIR_COMPONENT_COUNT = 8;

export const VECTOR_DISTANCE_WEIGHTS = {
  ratio: 0.0822,
  sameZIntersections: 0.2378,
  differentZIntersections: 0.0712,
  entryExitZChanges: 0.252,
  z: 0.3123,
  distWeight: 0.0446,
} as const;

export const getRawVecHeaderLength = (vector: number[]) => {
  if (vector.length <= LEGACY_RAW_VEC_HEADER_LENGTH) {
    return null;
  }

  if (
    vector.length >= RAW_VEC_HEADER_LENGTH &&
    (vector.length - RAW_VEC_HEADER_LENGTH) % RAW_VEC_PAIR_COMPONENT_COUNT === 0
  ) {
    return RAW_VEC_HEADER_LENGTH;
  }

  if (
    (vector.length - LEGACY_RAW_VEC_HEADER_LENGTH) %
      RAW_VEC_PAIR_COMPONENT_COUNT ===
    0
  ) {
    return LEGACY_RAW_VEC_HEADER_LENGTH;
  }

  return null;
};

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
  const headerLength = getRawVecHeaderLength(vector);
  if (headerLength === null) {
    return [...vector];
  }

  const ratio = vector[0];
  if (ratio === undefined) {
    return [...vector];
  }
  const header = vector.slice(0, headerLength);

  const pairs: RawVecPair[] = [];

  for (
    let index = headerLength;
    index < vector.length;
    index += RAW_VEC_PAIR_COMPONENT_COUNT
  ) {
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
    ...header,
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

    const headerLength = getRawVecHeaderLength(vector);
    if (headerLength === RAW_VEC_HEADER_LENGTH && index < headerLength) {
      if (index === 1) {
        return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.sameZIntersections);
      }

      if (index === 2) {
        return (
          value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.differentZIntersections)
        );
      }

      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.entryExitZChanges);
    }

    const componentIndex =
      (index - (headerLength ?? LEGACY_RAW_VEC_HEADER_LENGTH)) % 4;
    if (componentIndex === 0) {
      return 0;
    }

    if (componentIndex === 1) {
      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.z);
    }

    return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.distWeight);
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
  const headerLength =
    getRawVecHeaderLength(left) ?? LEGACY_RAW_VEC_HEADER_LENGTH;
  const ratioDelta = (left[0] ?? 0) - (right[0] ?? 0);
  const sameZIntersectionsDelta =
    headerLength === RAW_VEC_HEADER_LENGTH
      ? (left[1] ?? 0) - (right[1] ?? 0)
      : 0;
  const differentZIntersectionsDelta =
    headerLength === RAW_VEC_HEADER_LENGTH
      ? (left[2] ?? 0) - (right[2] ?? 0)
      : 0;
  const entryExitZChangesDelta =
    headerLength === RAW_VEC_HEADER_LENGTH
      ? (left[3] ?? 0) - (right[3] ?? 0)
      : 0;

  let zDistance = 0;
  let planarDistance = 0;

  for (let index = headerLength; index < left.length; index += 4) {
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
    planarDistance += xDelta * xDelta + yDelta * yDelta;
  }

  return Math.sqrt(
    ratioDelta * ratioDelta * VECTOR_DISTANCE_WEIGHTS.ratio +
      sameZIntersectionsDelta *
        sameZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.sameZIntersections +
      differentZIntersectionsDelta *
        differentZIntersectionsDelta *
        VECTOR_DISTANCE_WEIGHTS.differentZIntersections +
      entryExitZChangesDelta *
        entryExitZChangesDelta *
        VECTOR_DISTANCE_WEIGHTS.entryExitZChanges +
      zDistance * VECTOR_DISTANCE_WEIGHTS.z +
      planarDistance * VECTOR_DISTANCE_WEIGHTS.distWeight,
  );
};
