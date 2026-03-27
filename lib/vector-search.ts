export type SampleRawVecIndexEntry = {
  fileName: string;
  vecRaw: number[];
};

type RawVecPoint = {
  angle: number;
  z: number;
};

type RawVecPair = [RawVecPoint, RawVecPoint];

const VECTOR_MAGNITUDE_EPSILON = 1e-9;
const TAU = Math.PI * 2;
const LEXICOGRAPHIC_EPSILON = 1e-9;

export const VECTOR_DISTANCE_WEIGHTS = {
  ratio: 0.002,
  angle: 0.344,
  z: 0.654,
} as const;

const normalizeAngle = (angle: number) => {
  const normalizedAngle = angle % TAU;
  return normalizedAngle < 0 ? normalizedAngle + TAU : normalizedAngle;
};

const normalizeAngleDelta = (delta: number) => {
  const normalizedDelta = (delta + Math.PI) % TAU;
  return normalizedDelta < 0
    ? normalizedDelta + TAU - Math.PI
    : normalizedDelta - Math.PI;
};

const compareRawVecPointsForSweep = (
  leftPoint: RawVecPoint,
  rightPoint: RawVecPoint,
) => {
  if (leftPoint.z !== rightPoint.z) {
    return leftPoint.z - rightPoint.z;
  }

  return normalizeAngle(leftPoint.angle) - normalizeAngle(rightPoint.angle);
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
  if (vector.length <= 1 || (vector.length - 1) % 4 !== 0) {
    return [...vector];
  }

  const ratio = vector[0];
  if (ratio === undefined) {
    return [...vector];
  }

  const pairs: RawVecPair[] = [];

  for (let index = 1; index < vector.length; index += 4) {
    const firstAngle = vector[index];
    const firstZ = vector[index + 1];
    const secondAngle = vector[index + 2];
    const secondZ = vector[index + 3];

    if (
      firstAngle === undefined ||
      firstZ === undefined ||
      secondAngle === undefined ||
      secondZ === undefined
    ) {
      return [...vector];
    }

    const orderedPair = [
      { angle: firstAngle, z: firstZ },
      { angle: secondAngle, z: secondZ },
    ].sort(compareRawVecPointsForSweep) as RawVecPair;

    pairs.push(orderedPair);
  }

  const candidateAnchors = pairs.flatMap((pair) => [
    pair[0].angle,
    pair[1].angle,
  ]);

  const candidateVectors = candidateAnchors.map((anchorAngle) => {
    const shiftedPairs = pairs
      .map(
        (pair) =>
          [
            {
              angle: normalizeAngle(pair[0].angle - anchorAngle),
              z: pair[0].z,
            },
            {
              angle: normalizeAngle(pair[1].angle - anchorAngle),
              z: pair[1].z,
            },
          ].sort(compareRawVecPointsForSweep) as RawVecPair,
      )
      .sort(compareRawVecPairsForSweep);

    return [
      ratio,
      ...shiftedPairs.flatMap((pair) => [
        pair[0].angle,
        pair[0].z,
        pair[1].angle,
        pair[1].z,
      ]),
    ];
  });

  candidateVectors.sort((leftVector, rightVector) => {
    const vectorLength = Math.max(leftVector.length, rightVector.length);

    for (let index = 0; index < vectorLength; index += 1) {
      const leftValue = leftVector[index] ?? 0;
      const rightValue = rightVector[index] ?? 0;
      const delta = leftValue - rightValue;

      if (Math.abs(delta) > LEXICOGRAPHIC_EPSILON) {
        return delta;
      }
    }

    return 0;
  });

  return candidateVectors[0] ?? [...vector];
};

export const applyVectorWeights = (vector: number[]): number[] =>
  vector.map((value, index) => {
    if (index === 0) {
      return value * Math.sqrt(VECTOR_DISTANCE_WEIGHTS.ratio);
    }

    return (
      value *
      Math.sqrt(
        index % 2 === 0
          ? VECTOR_DISTANCE_WEIGHTS.z
          : VECTOR_DISTANCE_WEIGHTS.angle,
      )
    );
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

  let angleDistance = 0;
  let zDistance = 0;

  for (let index = 1; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;

    if (index % 2 === 1) {
      const angleDelta = normalizeAngleDelta(leftValue - rightValue);
      angleDistance += angleDelta * angleDelta;
    } else {
      const zDelta = leftValue - rightValue;
      zDistance += zDelta * zDelta;
    }
  }

  return Math.sqrt(
    ratioDelta * ratioDelta * VECTOR_DISTANCE_WEIGHTS.ratio +
      angleDistance * VECTOR_DISTANCE_WEIGHTS.angle +
      zDistance * VECTOR_DISTANCE_WEIGHTS.z,
  );
};
