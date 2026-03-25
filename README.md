# dataset-z09

`dataset-z09` is a deterministic corpus of intra-node routing problems for `tscircuit`-style solver work.

Each sample describes:

- a rectangular node
- a set of perimeter port points on `z=0` and `z=1`
- whether `HyperSingleIntraNodeSolver` could solve that node
- the solved routes, when a solution exists

The repository serves two distinct use cases:

1. Consume precomputed samples from `samples/`
2. Generate the deterministic node geometry for a sample index without running the solver

## What Is In The Repo

- [samples/](/Users/seve/w/tsc/dataset-z09/samples): the serialized dataset, plus generated JS/TS entrypoints
- [lib/generator.ts](/Users/seve/w/tsc/dataset-z09/lib/generator.ts): deterministic node generation utilities
- [lib/types.ts](/Users/seve/w/tsc/dataset-z09/lib/types.ts): dataset and route types
- [scripts/generate-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-samples.ts): sample generation with solver evaluation and size search
- [scripts/serialize-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/serialize-samples.ts): compact JSON serialization and module/declaration generation
- [pages/page.tsx](/Users/seve/w/tsc/dataset-z09/pages/page.tsx): local sample browser/debugger

## Dataset Shape

The main exported type is [`DatasetSample`](/Users/seve/w/tsc/dataset-z09/lib/types.ts), which is:

```ts
type DatasetSample = NodeWithPortPoints & {
  solvable: boolean
  solution: HighDensityIntraNodeRoute[] | null
}
```

The geometry portion is a [`NodeWithPortPoints`](/Users/seve/w/tsc/dataset-z09/lib/types.ts):

```ts
type NodeWithPortPoints = {
  capacityMeshNodeId: string
  center: { x: number; y: number }
  width: number
  height: number
  portPoints: PortPoint[]
  availableZ?: number[]
}
```

## Determinism

Sample geometry is deterministic for a given `sampleIndex` and `datasetSeed`.

That means:

- `generateNodeWithPortPoints(42)` always returns the same node geometry
- sample generation is reproducible
- consumers can derive a sample node without running solver logic

The default seed is exported as `DEFAULT_DATASET_SEED`.

## Using The Precomputed Samples

### All Samples

Use [samples/index.js](/Users/seve/w/tsc/dataset-z09/samples/index.js) when you want the whole serialized dataset.

```js
import samples, { sample000000, sample000123 } from "./samples/index.js"

console.log(samples.length)
console.log(sample000000.solvable)
console.log(sample000123.solution)
```

TypeScript declarations are available in [samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/samples/index.d.ts).

### First 100 Samples

Use [samples/first100.js](/Users/seve/w/tsc/dataset-z09/samples/first100.js) for a much smaller subset that is convenient for tests, demos, and local experiments.

```js
import first100, { sample000000, sample000099 } from "./samples/first100.js"

console.log(first100.length) // 100
```

Declarations live in [samples/first100.d.ts](/Users/seve/w/tsc/dataset-z09/samples/first100.d.ts).

## Generating Nodes Without Running The Solver

Use [samples/generate.js](/Users/seve/w/tsc/dataset-z09/samples/generate.js) when you want the deterministic node shape only.

This entrypoint does **not**:

- run `HyperSingleIntraNodeSolver`
- compute `solvable`
- search for the smallest solvable size
- write any files

It only returns the generated `NodeWithPortPoints`.

```js
import generateSampleNode, {
  DEFAULT_DATASET_SEED,
  generateNodeWithPortPoints,
} from "./samples/generate.js"

const nodeA = generateSampleNode(0)
const nodeB = generateNodeWithPortPoints(25, DEFAULT_DATASET_SEED)

console.log(nodeA.width, nodeA.height)
console.log(nodeB.portPoints.length)
```

TypeScript declarations live in [samples/generate.d.ts](/Users/seve/w/tsc/dataset-z09/samples/generate.d.ts).

## How Samples Are Produced

The full dataset generation flow in [scripts/generate-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-samples.ts) does more than create random nodes:

1. Generate a deterministic starting node for each `sampleIndex`
2. Run `HyperSingleIntraNodeSolver`
3. If solvable, repeatedly shrink by `0.9` until the node becomes unsolved
4. If unsolved, repeatedly grow by `1.1` until the node becomes solvable or limits are reached
5. Store the final node, `solvable`, and `solution`

So the dataset files are not just raw outputs of `generateNodeWithPortPoints`. They are the result of deterministic generation plus solver-guided size search.

## Local Development

Install dependencies:

```bash
bun install
```

Run the local viewer:

```bash
bun run start
```

Type-check:

```bash
bun run typecheck
```

Format-check:

```bash
bun run formatcheck
```

## Regenerating The Dataset

Generate fresh samples:

```bash
bun run generate:samples
```

Generate a specific number of samples:

```bash
bun run generate:samples --sample-count 500
```

Resume an interrupted run:

```bash
bun run generate:samples --resume
```

Split work across workers:

```bash
bun run generate:samples --worker 1/4
bun run generate:samples --worker 2/4
bun run generate:samples --worker 3/4
bun run generate:samples --worker 4/4
```

## Re-serializing The Samples

After generating or modifying sample JSON files, rebuild the compact serialized form and the JS/TS entrypoints:

```bash
bun run serialize:samples
```

This script:

- minifies every sample JSON file
- rounds numeric values to two decimals only when the rounded number is shorter to write
- regenerates [samples/index.js](/Users/seve/w/tsc/dataset-z09/samples/index.js)
- regenerates [samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/samples/index.d.ts)
- regenerates [samples/first100.js](/Users/seve/w/tsc/dataset-z09/samples/first100.js)
- regenerates [samples/first100.d.ts](/Users/seve/w/tsc/dataset-z09/samples/first100.d.ts)

## Notes On Size

The dataset is intentionally stored as JSON because it is easy to inspect, diff, and consume from JS/TS tooling.

To keep the repository smaller:

- sample files are minified
- numbers are serialized in the shorter of plain form and rounded-2-decimal form
- `first100` is available as a lighter import surface for tests and demos

If you need raw geometry only, prefer `samples/generate.js` over importing the full serialized dataset.

## Caveats

- Importing [samples/index.js](/Users/seve/w/tsc/dataset-z09/samples/index.js) loads the entire dataset module graph, which is large.
- For lightweight consumers, use [samples/first100.js](/Users/seve/w/tsc/dataset-z09/samples/first100.js) or [samples/generate.js](/Users/seve/w/tsc/dataset-z09/samples/generate.js).
- `bun run typecheck` currently reports an unrelated existing error in [pages/solutions.page.tsx](/Users/seve/w/tsc/dataset-z09/pages/solutions.page.tsx#L196).

## Summary

Use:

- [samples/index.js](/Users/seve/w/tsc/dataset-z09/samples/index.js) for the full solved dataset
- [samples/first100.js](/Users/seve/w/tsc/dataset-z09/samples/first100.js) for a compact subset
- [samples/generate.js](/Users/seve/w/tsc/dataset-z09/samples/generate.js) for deterministic node generation without solver execution
