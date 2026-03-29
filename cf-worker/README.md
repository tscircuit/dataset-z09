# Cloudflare Worker Solve Cache

This Worker exposes a small HTTP API around the dataset solve-cache pipeline.

Routes:

- `GET /health`
- `GET /debug/kv-read`
- `POST /solve`
- `POST /solve-batch`
- `POST /solve-batch-binary`
- `GET /ws/solve-batch-binary`
- `POST /admin/upsert-bucket`

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
8. Compare a pre-opened WebSocket binary batch path with:
   `bun run scripts/profile-websocket-deployment.ts --url https://... --pair-count 4`
9. Benchmark plain health vs a tiny KV read with:
   `bun run scripts/profile-kv-read-deployment.ts --url https://...`

`POST /solve` accepts a raw `NodeWithPortPoints` payload and returns either:

- a cache hit, or
- a freshly solved and validated route set, which is then written back to KV.

The returned routes are mapped back onto the caller's original connection names.

`POST /solve-batch-binary` is the low-overhead batch path. It accepts a packed
binary request containing up to 64 nodes encoded as quantized center/size data
plus ordered point pairs, and it returns packed binary routes using quantized
coordinates instead of verbose JSON route objects. This avoids repeating
connection names and object keys for every point in the response.

`GET /ws/solve-batch-binary` upgrades to a persistent WebSocket that uses the
same packed binary request/response format as `POST /solve-batch-binary`.
Open the socket once, send binary batch requests as messages, and read one
binary response message per request.

`GET /debug/kv-read` is a minimal diagnostic endpoint that reads one tiny KV key
and returns its internal `kvGet` timing. It is useful for separating network /
front-door latency from KV access latency.

Notes:

- `wrangler.toml` ships with placeholder KV ids on purpose. Replace them after
  creating the namespace.
- The seed script expands each validated cache entry across all solve-cache
  symmetries, groups the resulting variants by `${pairCount}:${zSignature}`, and
  uploads those buckets through the authenticated admin endpoint.
