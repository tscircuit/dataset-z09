# Cache Pipeline Explanation

## Abstract

This repository uses a `solve-cache-N.json` file to reuse previously solved routing patterns for capacity-mesh nodes with `N` point pairs. The cache pipeline is not a direct memoization of exact samples. Instead, it is a geometric reuse system:

1. Canonicalize a sample into a stable representation.
2. Rank cached entries by a lightweight geometric descriptor (`vecRaw`).
3. Expand each cache entry across symmetry variants.
4. Take the nearest few candidates and try to physically reuse them.
5. Validate the reused result with reattachment, force-improvement, and DRC.
6. If reuse fails, solve a new sample, shrink it to the smallest valid representative, and add that representative to the cache.

The system exploits invariances under connection renaming, pair ordering, planar board symmetries, and a 2-layer `z` swap. The cache is therefore a library of reusable routing motifs rather than a table of exact solved boards.

## Goals

The pipeline is designed to optimize two competing concerns:

- fast approximate lookup
- strict physical validity

The approximate lookup is done by `vecRaw` and weighted distance. Physical validity is enforced only after reuse by scaling, reattachment, force-improvement, and DRC. This split is deliberate: the descriptor is allowed to be imperfect, because the final acceptance test is geometric and rule-based.

## Main Files

- [scripts/generate-solve-cache.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-solve-cache.ts): cache generation loop
- [lib/solve-cache.ts](/Users/seve/w/tsc/dataset-z09/lib/solve-cache.ts): canonicalization, symmetry expansion, matching, reattachment, validation
- [lib/vec-raw.ts](/Users/seve/w/tsc/dataset-z09/lib/vec-raw.ts): raw vector feature extraction
- [lib/vector-search.ts](/Users/seve/w/tsc/dataset-z09/lib/vector-search.ts): canonicalized vector distance and runtime weights
- [lib/drc-check.ts](/Users/seve/w/tsc/dataset-z09/lib/drc-check.ts): geometry and connectivity validation
- [scripts/calibrate-vector-distance-weights.ts](/Users/seve/w/tsc/dataset-z09/scripts/calibrate-vector-distance-weights.ts): offline weight fitting

## Core Idea

A cache entry stores:

- a canonical sample geometry
- a canonical routed solution
- a precomputed `vecRaw`

When a new sample arrives, the system does not ask “is this exact sample in the cache?” It asks:

- which cached geometries look most similar after canonicalization and symmetry expansion?
- can one of those routed solutions be scaled and reattached to the new sample?
- does that reused route remain valid after force-improvement and DRC?

If yes, it is a cache hit. If not, the sample becomes a candidate for cache growth.

## Sample Canonicalization

Canonicalization is the first major compression step.

### Why canonicalize?

Without canonicalization, the same geometry could appear many ways:

- point pairs listed in different orders
- endpoints within a pair swapped
- connection names renamed
- root net names renamed

All of those should be treated as the same underlying routing problem.

### What canonicalization does

`canonicalizeDatasetSample(...)` and `canonicalizeNodeWithPortPoints(...)` in [lib/solve-cache.ts](/Users/seve/w/tsc/dataset-z09/lib/solve-cache.ts) do the following:

- group port points by `connectionName`
- enforce exactly 2 port points per connection
- order the two points in each pair
- order the pairs globally
- rename pairs to canonical names like `conn00`, `conn01`, ...
- rename root nets to canonical names like `root00`, `root01`, ...
- reorder any stored routes to match the canonical connection names

### Ordering rule

Ordering is intentionally layer-first:

- first compare `z`
- then compare sweep angle around the node center
- then compare `x`
- then compare `y`

This means canonical order is effectively:

- a `z=0` sweep
- then a `z=1` sweep

That is important because earlier versions were too rotation-invariant and weakened the descriptor. The current system preserves absolute orientation and only removes naming and ordering noise.

## Raw Vector (`vecRaw`)

`vecRaw` is the lookup descriptor used to rank approximate neighbors.

The current layout is:

```text
[ratio, sameZIntersections, differentZIntersections, entryExitZChanges,
 angle0, z0, x0, y0,
 angle1, z1, x1, y1,
 ...]
```

### Header terms

The header contains coarse global features:

- `ratio = width / height`
- `sameZIntersections`
- `differentZIntersections`
- `entryExitZChanges`

These three topology terms are computed from straight-line pair geometry, not from actual solved routes.

#### `sameZIntersections`

Count pair-pair XY intersections where both intersecting pairs are fixed on the same single layer.

#### `differentZIntersections`

Count pair-pair XY intersections that are not `sameZIntersections`, including cases where one or both pairs change layers.

#### `entryExitZChanges`

Count individual pairs whose two endpoints have different `z`.

### Per-point terms

For every canonicalized port point, `vecRaw` stores:

- `angle` relative to the node center
- `z`
- normalized `x`
- normalized `y`

Normalized `x` and `y` are scaled by half-width and half-height respectively, so they are roughly shape-relative coordinates rather than absolute board units.

### What `vecRaw` is for

`vecRaw` is only a ranking feature. It is not a proof that a route can be reused.

That distinction matters:

- `vecRaw` can admit false positives
- DRC and reattachment reject false positives

## Vector Canonicalization and Distance

The distance function lives in [lib/vector-search.ts](/Users/seve/w/tsc/dataset-z09/lib/vector-search.ts).

### Structural canonicalization

Before distance is computed:

- the whole `vecRaw` is canonicalized again structurally
- the header is preserved as-is
- points are ordered within each pair
- pairs are ordered globally

This makes the descriptor invariant to pair ordering and endpoint ordering, but not to arbitrary rotation.

### Weighted distance

Distance is computed as a weighted Euclidean-like metric over:

- ratio delta squared
- same-layer topology delta squared
- cross-layer topology delta squared
- entry/exit layer-change delta squared
- total `z` delta squared over points
- total planar (`x/y`) delta squared over points

At the time of writing, the runtime weights are:

```text
ratio=0.1449
sameZIntersections=0.1891
differentZIntersections=0.1459
entryExitZChanges=0.2007
z=0.2247
distWeight=0.0946
```

Those are configured in [lib/vector-search.ts](/Users/seve/w/tsc/dataset-z09/lib/vector-search.ts).

## Symmetry Model

The cache does not only compare against the stored entry as written. It compares against symmetry-transformed variants.

### Planar symmetries

The planar symmetries are the 8 elements of the square dihedral group:

- `identity`
- `flipX`
- `flipY`
- `rotate90`
- `rotate180`
- `rotate270`
- `flipDiagonal`
- `flipAntiDiagonal`

### Layer symmetry

The pipeline also applies a 2-layer swap:

- `flipZ`: map `z=0 -> 1` and `z=1 -> 0`

This is then composed with every planar symmetry.

### Total symmetry count

The total symmetry set is therefore:

- `D4 x C2 = 8 x 2 = 16`

Not 32.

### What is transformed

For each symmetry variant, the pipeline transforms:

- sample port-point coordinates
- node width/height when axes swap
- routed path points
- routed path `z` values when `flipZ` is present
- vias and jumper endpoints in XY

The transformed result is then re-canonicalized into a fresh cache entry. This is important because the matcher always works in a canonical frame.

## Cache Matching

Matching is implemented in [lib/solve-cache.ts](/Users/seve/w/tsc/dataset-z09/lib/solve-cache.ts).

### Candidate generation

For a target sample:

1. compute `vecRaw`
2. expand each cache entry across all 16 symmetries
3. compute vector distance for every valid-length variant
4. sort by distance

### Candidate acceptance

The system does not trust the nearest neighbor blindly.

It takes only the first `K` candidates, where the default is:

- `DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY = 16`

Then it tries them in order until one succeeds.

### Reuse path

The reuse path for a candidate is:

1. scale stored routes from source sample size to target sample size
2. reattach route endpoints to the target sample’s actual port points
3. simplify routes
4. run force-directed improvement
5. run DRC
6. if improved routes fail but raw reattached routes pass, accept the raw routes

This makes the cache much more robust than simple “copy and scale”.

### Why top-16?

The distance function is only approximate. The best reusable route is often not the single nearest descriptor match. Trying a short shortlist is a practical compromise:

- much more reliable than nearest-only
- still much cheaper than testing the whole cache

## Reattachment

Reattachment is the bridge from approximate geometric similarity to an actual route.

The stored route is first scaled to the target node’s size. Then `reattachRouteToNode(...)`:

- finds the two target port points for the route’s connection
- chooses forward or reversed route orientation by endpoint distance
- snaps the route’s first point to one target port
- snaps the route’s last point to the other target port

Reversal is not treated as a separate symmetry because reattachment already handles endpoint orientation.

## DRC as the Final Authority

The most important design principle in this system is:

`vecRaw` ranks; DRC decides.

The DRC checker in [lib/drc-check.ts](/Users/seve/w/tsc/dataset-z09/lib/drc-check.ts) enforces:

- route must correspond to exactly 2 sample port points
- route endpoints must attach exactly in 3D
- route must leave and arrive on the same layer as the attached endpoint
- no immediate zero-length layer switch at an endpoint
- no same-layer trace-trace clearance violations
- no via-trace clearance violations
- no via-via clearance violations
- no out-of-bounds route points
- no out-of-bounds vias
- no segment changing `z` without a colocated via

### Same-net handling

For clearance checks, net identity is normalized as:

- `rootConnectionName ?? connectionName`

So same-root routes are not penalized for overlapping their own net.

### Why DRC matters so much

The descriptor is intentionally coarse. It does not encode full route geometry. That is acceptable because every accepted reuse must still survive DRC.

## Cache Construction

The cache generation loop is in [scripts/generate-solve-cache.ts](/Users/seve/w/tsc/dataset-z09/scripts/generate-solve-cache.ts).

### High-level loop

For a given `pointPairCount`:

1. load `solve-cache-N.json` if it exists
2. repeatedly generate random canonicalized samples
3. attempt to reuse the cache
4. if reuse fails, solve a new representative and add it to the cache
5. stop only when rolling accuracy is perfect over the last 1000 samples

### Hit and miss

A sample is a hit if any of the first 16 ranked candidates reuses cleanly.

A sample is a miss if none of those candidates survives reattachment + force-improve + DRC.

On a miss, the generator logs the nearest failed candidate, including:

- source entry index
- symmetry variant
- vector distance
- whether failure was reattachment or DRC
- summarized DRC issue counts

### Rolling stop condition

The generator reports:

```text
cacheSize=... rolling1000Accuracy=...
```

and stops only when:

- the rolling window has 1000 samples
- all 1000 are hits

## Cache Growth by Solving and Shrinking

When the cache misses, the system does not simply store the failed sample.

Instead it searches for a compact representative.

### Search procedure

1. Try to solve the current sample with `HyperSingleIntraNodeSolver`.
2. If unsolved, repeatedly grow the node by `1.1x` until a valid solved entry exists or scaling limits are hit.
3. Once a valid solved entry exists, repeatedly shrink it:
   - coarse shrink by `0.9x` until failure
   - then fine shrink by `0.98x` until failure
4. Keep the smallest entry that still passes full validation.

### Important constraint

Only DRC-clean validated entries are ever added to the cache.

That means:

- solving alone is not enough
- a route that cannot be reused cleanly after canonicalization is discarded

This keeps the cache biased toward reusable motifs rather than merely solvable one-offs.

## Cache Compatibility

There are two compatibility mechanisms.

### Solve cache compatibility

`parseSolveCacheFile(...)` rebuilds cache entries through `createSolveCacheEntry(...)`, which means:

- old serialized `vecRaw` values are ignored
- canonical naming is refreshed
- new descriptor fields are recomputed from geometry

This is why changes to `vecRaw` do not require manual migration of old `solve-cache-N.json` files.

### Raw-vec index compatibility

`VEC_RAW_VERSION` in [lib/vec-raw.ts](/Users/seve/w/tsc/dataset-z09/lib/vec-raw.ts) versions the simplified-sample raw-vec index. When the version changes, the index is regenerated instead of trusted.

## Weight Calibration

The offline calibration script is [scripts/calibrate-vector-distance-weights.ts](/Users/seve/w/tsc/dataset-z09/scripts/calibrate-vector-distance-weights.ts).

### Objective

The calibration target is not abstract vector similarity. It is cache usefulness:

- rank candidates by weighted descriptor distance
- inspect the top `K` candidates, default `K=16`
- if any candidate reattaches and passes DRC, the sample counts as a hit

This is the same metric the runtime cache actually cares about.

### Training data

For pair-count `N`, every cache entry is treated as a training sample, and every symmetry-transformed cache entry is treated as a possible reusable variant.

### Current optimization strategy

The current fitter uses:

- minibatch SGD
- a softmax-logit parameterization so weights stay positive and sum to 1
- a logistic margin loss
- regularization toward uniform weights
- full-dataset evaluation after every epoch
- best-weight tracking by evaluation accuracy, then average first-pass rank

### Performance structure

The current script avoids the worst combinatorial blow-up by:

- creating a shared symmetry-variant pool once
- canonicalizing `vecRaw` once per sample and once per variant
- doing bounded top-`maxProbeRank` ranking on demand instead of full sorting
- caching DRC verdicts by `(targetEntryIndex, sourceEntryIndex, symmetry)`

### Output

The script reports:

- online epoch accuracy
- post-epoch full-dataset evaluation accuracy
- average first passing rank
- DRC cache hit/miss counts
- current weights
- optional JSON snapshots via `--json-output`

## What the Pipeline Exploits

At a high level, the system exploits the following invariances and regularities.

### 1. Naming invariance

Connection names and root net names are arbitrary labels. Canonicalization removes that entropy.

### 2. Ordering invariance

Pair order and endpoint order are not semantically meaningful. Canonicalization removes that too.

### 3. Planar symmetry

Many routing problems are equivalent after rotation or reflection. The cache explicitly searches those equivalences.

### 4. Layer symmetry

On a 2-layer board, swapping top and bottom often preserves routability. `flipZ` doubles the useful search space.

### 5. Scale family reuse

A solved pattern is useful across a family of similar sizes. Scaling plus reattachment exploits this.

### 6. Coarse topology priors

Intersection counts and entry/exit layer changes give cheap hints about routing difficulty and motif similarity.

## What Can Be Tuned

The main knobs are:

### Matching

- runtime weights in [lib/vector-search.ts](/Users/seve/w/tsc/dataset-z09/lib/vector-search.ts)
- `DEFAULT_MAX_SOLVE_CACHE_CANDIDATES_TO_TRY`
- whether additional features are added to `vecRaw`

### Reuse robustness

- force-improvement passes for reuse
- force-improvement passes for cache validation
- simplification behavior

### Cache growth

- solver max iterations
- grow factor
- coarse shrink factor
- fine shrink factor
- trace width and via diameter assumptions

### Stop condition

- rolling window size
- required rolling accuracy threshold

### Calibration

- batch size
- learning rate
- temperature
- regularization strength
- `topK`
- `maxProbeRank`

## Limitations

### `vecRaw` is intentionally lossy

It does not encode full route shape, only sample geometry and a few topological summaries. That makes lookup fast, but it also means descriptor similarity is only a hint.

### Topology terms are straight-line approximations

`sameZIntersections` and `differentZIntersections` are computed from port-pair line segments, not actual routed traces. They are coarse problem-shape features, not route-level facts.

### DRC is still expensive

The real cost is not descriptor distance. The real cost is testing candidate reuses with DRC. That is why the pipeline uses:

- a short top-16 shortlist at runtime
- bounded probing during calibration
- DRC result caching during training

### Calibration still scales with cache size

Even with current speedups, larger pair counts are expensive because:

- the number of base entries grows
- each base entry expands across 16 symmetries
- DRC validation is discrete and geometry-heavy

## Practical Mental Model

The best mental model for this system is:

- `vecRaw` is a learned coarse index over routing problem shapes.
- symmetry expansion turns one cache entry into a family of equivalent motifs.
- reattachment maps a stored motif onto a concrete new sample.
- force-improvement and DRC determine whether the motif actually survives that mapping.
- the cache generator keeps only compact, reusable, DRC-clean motifs.

That division of labor is the main reason the pipeline works: a cheap descriptor narrows the search, and an exact validator prevents incorrect reuse.
