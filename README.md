# dataset-z09

`dataset-z09` is a deterministic corpus of intra-node routing problems for `tscircuit`-style solver work.

Each sample describes:

- a rectangular node
- a set of perimeter port points on `z=0` and `z=1`
- whether `HyperSingleIntraNodeSolver` could solve that node
- the solved routes, when a solution exists

The repository serves three distinct use cases:

1. Consume direct solver output from `direct-out-samples/`
2. Consume simplified output from `simplified-samples/`
3. Generate the deterministic node geometry for a sample index without running the solver

## What Is In The Repo

- [direct-out-samples/](/Users/seve/w/tsc/dataset-z09/direct-out-samples): the serialized direct solver output, plus generated JS/TS entrypoints
- [simplified-samples/](/Users/seve/w/tsc/dataset-z09/simplified-samples): the serialized simplified dataset, after route simplification and force improvement
- [lib/generator.ts](/Users/seve/w/tsc/dataset-z09/lib/generator.ts): deterministic node generation utilities
- [lib/sample-directories.ts](/Users/seve/w/tsc/dataset-z09/lib/sample-directories.ts): shared sample directory names
- [lib/types.ts](/Users/seve/w/tsc/dataset-z09/lib/types.ts): dataset and route types
- [scripts/generate-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-samples.ts): sample generation with solver evaluation and size search
- [scripts/simplify-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/simplify-samples.ts): route simplification plus 500 force-improvement passes into `simplified-samples/`
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

Use [direct-out-samples/index.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.js) when you want the whole direct solver output dataset.

```js
import samples, { sample000000, sample000123 } from "./direct-out-samples/index.js"

console.log(samples.length)
console.log(sample000000.solvable)
console.log(sample000123.solution)
```

TypeScript declarations are available in [direct-out-samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.d.ts).

### First 100 Samples

Use [direct-out-samples/first100.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.js) for a much smaller subset that is convenient for tests, demos, and local experiments.

```js
import first100, { sample000000, sample000099 } from "./direct-out-samples/first100.js"

console.log(first100.length) // 100
```

Declarations live in [direct-out-samples/first100.d.ts](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.d.ts).

### Simplified Samples

Use [simplified-samples/index.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.js) when you want routes after `simplifyRoutes` plus 500 force-improvement passes.

```js
import simplifiedSamples from "./simplified-samples/index.js"

console.log(simplifiedSamples[0]?.solution)
```

Declarations live in [simplified-samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.d.ts).

## Generating Nodes Without Running The Solver

Use [direct-out-samples/generate.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/generate.js) when you want the deterministic node shape only.

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
} from "./direct-out-samples/generate.js"

const nodeA = generateSampleNode(0)
const nodeB = generateNodeWithPortPoints(25, DEFAULT_DATASET_SEED)

console.log(nodeA.width, nodeA.height)
console.log(nodeB.portPoints.length)
```

TypeScript declarations live in [direct-out-samples/generate.d.ts](/Users/seve/w/tsc/dataset-z09/direct-out-samples/generate.d.ts).

## How Samples Are Produced

The full dataset generation flow in [scripts/generate-samples.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-samples.ts) does more than create random nodes:

1. Generate a deterministic starting node for each `sampleIndex`
2. Run `HyperSingleIntraNodeSolver`
3. If solvable, repeatedly shrink by `0.9` until the node becomes unsolved
4. If unsolved, repeatedly grow by `1.1` until the node becomes solvable or limits are reached
5. Store the final node, `solvable`, and `solution` in `direct-out-samples/`
6. Optionally simplify the stored routes into `simplified-samples/`

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

Generate simplified samples:

```bash
bun run simplify:samples
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
- regenerates [direct-out-samples/index.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.js)
- regenerates [direct-out-samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.d.ts)
- regenerates [direct-out-samples/first100.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.js)
- regenerates [direct-out-samples/first100.d.ts](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.d.ts)
- regenerates [simplified-samples/index.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.js)
- regenerates [simplified-samples/index.d.ts](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.d.ts)
- regenerates [simplified-samples/first100.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/first100.js)
- regenerates [simplified-samples/first100.d.ts](/Users/seve/w/tsc/dataset-z09/simplified-samples/first100.d.ts)

## Notes On Size

The dataset is intentionally stored as JSON because it is easy to inspect, diff, and consume from JS/TS tooling.

To keep the repository smaller:

- sample files are minified
- numbers are serialized in the shorter of plain form and rounded-2-decimal form
- `first100` is available as a lighter import surface for tests and demos

If you need raw geometry only, prefer `direct-out-samples/generate.js` over importing either serialized dataset.

## Caveats

- Importing [direct-out-samples/index.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.js) or [simplified-samples/index.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.js) loads a large module graph.
- For lightweight consumers, use [direct-out-samples/first100.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.js), [simplified-samples/first100.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/first100.js), or [direct-out-samples/generate.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/generate.js).
- `bun run typecheck` currently reports an unrelated existing error in [pages/solutions.page.tsx](/Users/seve/w/tsc/dataset-z09/pages/solutions.page.tsx#L196).

## Summary

Use:

- [direct-out-samples/index.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/index.js) for the full direct solver output
- [simplified-samples/index.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/index.js) for the full simplified dataset
- [direct-out-samples/first100.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/first100.js) for a compact direct-output subset
- [simplified-samples/first100.js](/Users/seve/w/tsc/dataset-z09/simplified-samples/first100.js) for a compact simplified subset
- [direct-out-samples/generate.js](/Users/seve/w/tsc/dataset-z09/direct-out-samples/generate.js) for deterministic node generation without solver execution
