# Cloudflare Worker Solve Cache

This Worker exposes a small HTTP API around the dataset solve-cache pipeline.

Routes:

- `GET /health`
- `POST /solve`
- `POST /solve-batch`
- `POST /solve-batch-binary`
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

`POST /solve` accepts a raw `NodeWithPortPoints` payload and returns either:

- a cache hit, or
- a freshly solved and validated route set, which is then written back to KV.

The returned routes are mapped back onto the caller's original connection names.

`POST /solve-batch-binary` is the low-overhead batch path. It accepts a packed
binary request containing up to 64 nodes encoded as quantized center/size data
plus ordered point pairs, and it returns packed binary routes using quantized
coordinates instead of verbose JSON route objects. This avoids repeating
connection names and object keys for every point in the response.

Notes:

- `wrangler.toml` ships with placeholder KV ids on purpose. Replace them after
  creating the namespace.
- The seed script expands each validated cache entry across all solve-cache
  symmetries, groups the resulting variants by `${pairCount}:${zSignature}`, and
  uploads those buckets through the authenticated admin endpoint.
