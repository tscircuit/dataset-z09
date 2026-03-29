# Cloudflare Worker Solve Cache

This Worker exposes a small HTTP API around the dataset solve-cache pipeline.

Routes:

- `GET /health`
- `GET /debug/kv-read`
- `POST /debug/echo-binary`
- `POST /debug/echo-json`
- `POST /debug/stage/decode-binary`
- `POST /debug/stage/canonicalize-binary`
- `POST /debug/stage/load-buckets-binary`
- `POST /debug/stage/parse-buckets-binary`
- `POST /debug/stage/match-binary`
- `POST /debug/stage/solve-batch-lite-binary`
- `POST /debug/stage/vectorize-query-binary`
- `POST /debug/stage/vectorize-fetch-binary`
- `POST /debug/stage/vectorize-match-binary`
- `POST /solve`
- `POST /solve-batch`
- `POST /solve-batch-binary`
- `POST /admin/upsert-bucket`
- `POST /admin/upsert-vectorize-entries`

The worker stores z-bucketed cache variants in Workers KV under keys of the
form `${pairCount}:${zSignature}`. Each bucket contains only the transformed
solve-cache entries whose canonical z signature matches that key.

Typical flow:

1. Create a KV namespace:
   `bunx wrangler kv namespace create SOLVE_CACHE`
2. Copy the returned `id` and `preview_id` into `wrangler.toml`.
3. Set an admin token for bucket seeding:
   `bunx wrangler secret put ADMIN_TOKEN`
4. Deploy the worker:
   `bun run deploy`
5. Seed one or more local `solve-cache-*.json` files with:
   `bun run scripts/seed-deployment-cache.ts --url https://... --pair-count 4 --admin-token ...`
6. Benchmark the deployed worker with:
   `bun run scripts/profile-deployment.ts --url https://... --pair-count 4`
7. Compare JSON compact versus packed binary batches with:
   `bun run scripts/profile-binary-deployment.ts --url https://... --pair-count 4`
8. Benchmark plain health vs a tiny KV read with:
   `bun run scripts/profile-kv-read-deployment.ts --url https://...`
9. Seed the pair-4 Vectorize shadow index with:
   `bun run scripts/seed-vectorize-index.ts --url https://... --pair-count 4 --admin-token ...`
10. Compare the current bucket matcher against the Vectorize shadow path with:
   `bun run scripts/profile-vectorize-deployment.ts --url https://... --pair-count 4`

`POST /solve` accepts a raw `NodeWithPortPoints` payload and returns either:

- a cache hit, or
- a freshly solved and validated route set, which is then written back to KV.

The returned routes are mapped back onto the caller's original connection names.

`POST /solve-batch-binary` is the low-overhead batch path. It accepts a packed
binary request containing up to 64 nodes encoded as quantized center/size data
plus ordered point pairs, and it returns packed binary routes using quantized
coordinates instead of verbose JSON route objects. This avoids repeating
connection names and object keys for every point in the response.

`GET /debug/kv-read` is a minimal diagnostic endpoint that reads one tiny KV key
and returns basic value metadata. It is useful for separating network /
front-door latency from KV access latency using an external timer.

The `POST /debug/stage/*` endpoints are cumulative stage probes for the packed
binary batch request:

- `decode-binary`: body read + binary decode
- `canonicalize-binary`: decode + canonicalization + z-signature bucketing
- `load-buckets-binary`: canonicalization + raw KV reads for unique buckets
- `parse-buckets-binary`: KV reads + JSON parse of those bucket payloads
- `match-binary`: bucket parse + cache-match attempt only, with no solver
- `solve-batch-lite-binary`: full solve-cache batch path with a tiny JSON response
- `vectorize-query-binary`: canonicalization + Vectorize ANN queries only
- `vectorize-fetch-binary`: Vectorize ANN queries + KV fetch of the top ids
- `vectorize-match-binary`: Vectorize ANN queries + KV fetch + reattach/DRC match

The Vectorize shadow path currently targets pair-count `4` only. It stores one
vector per transformed solve-cache entry, keyed by `entryId`. The full entry
payload remains in KV under `entry:${entryId}`, so Vectorize only needs to
return ids for the top matches.

Notes:

- `wrangler.toml` ships with placeholder KV ids on purpose. Replace them after
  creating the namespace.
- The seed script expands each validated cache entry across all solve-cache
  symmetries, groups the resulting variants by `${pairCount}:${zSignature}`, and
  uploads those buckets through the authenticated admin endpoint.
