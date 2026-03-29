# Cloudflare Worker Solve Cache

This Worker exposes a single-node solve-cache API.

Routes:

- `GET /health`
- `GET /debug/kv-read`
- `POST /solve`
- `POST /admin/upsert-vectorize-entries`

The worker uses Vectorize for candidate search and Workers KV for full entry
payloads. Vectorize stores one vector per transformed solve-cache entry, and KV
stores the corresponding entry JSON under `entry:${entryId}`.

Typical flow:

1. Create a KV namespace:
   `bunx wrangler kv namespace create SOLVE_CACHE`
2. Copy the returned `id` and `preview_id` into `wrangler.toml`.
3. Set an admin token:
   `bunx wrangler secret put ADMIN_TOKEN`
4. Deploy the worker:
   `bun run deploy`
5. Seed one or more local `solve-cache-*.json` files with:
   `bun run scripts/seed-vectorize-index.ts --url https://... --pair-count 4 --admin-token ...`
6. Benchmark the deployed worker with:
   `bun run scripts/profile-deployment.ts --url https://... --pair-count 4`
7. Benchmark plain health vs a tiny KV read with:
   `bun run scripts/profile-kv-read-deployment.ts --url https://...`

`POST /solve` accepts a raw `NodeWithPortPoints` payload and returns either:

- a cache hit, or
- a freshly solved and validated route set, which is then written back to KV.

The returned routes are mapped back onto the caller's original connection names.
Cache hits use the single-node Vectorize path: query the nearest entries, fetch
those entry payloads from KV, and then reattach and validate them.

`GET /debug/kv-read` is a minimal diagnostic endpoint that reads one tiny KV key
and returns basic value metadata. It is useful for separating network /
front-door latency from KV access latency using an external timer.

Notes:

- `wrangler.toml` ships with real bindings for the current deployment; adjust if
  you create new namespaces or indexes.
- The seed script expands each validated cache entry across all solve-cache
  symmetries and uploads those transformed variants to KV + Vectorize through
  the authenticated admin endpoint.
