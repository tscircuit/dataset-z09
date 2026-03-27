export type SampleRawVecIndexEntry = {
  fileName: string;
  vecRaw: number[];
};

const VECTOR_MAGNITUDE_EPSILON = 1e-9;
const RATIO_WEIGHT = 10;
const Z_WEIGHT = 10;

export const applyVectorWeights = (vector: number[]): number[] =>
  vector.map((value, index) => {
    if (index === 0) {
      return value * RATIO_WEIGHT;
    }

    return index % 2 === 0 ? value * Z_WEIGHT : value;
  });

export const canonicalizeVector = (vector: number[]): number[] => {
  const weightedVector = applyVectorWeights(vector);
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

  const left = canonicalizeVector(leftVector);
  const right = canonicalizeVector(rightVector);
  let total = 0;

  for (let index = 0; index < left.length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    total += delta * delta;
  }

  return Math.sqrt(total);
};
