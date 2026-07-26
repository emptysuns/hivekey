# llm-api-pool

**English** | [简体中文](README.zh-CN.md)

A self-hosted LLM API key pool. Put all the API keys of an OpenAI-compatible endpoint behind a single URL, and llm-api-pool load-balances requests across them with smart scheduling, automatic retry/failover on 429s and errors, per-key cooldowns, proxy support, and a real-time web dashboard for managing everything. Design inspired by [new-api](https://github.com/QuantumNous/new-api).

```
your app ──▶ http://pool:3000/v1  ──▶ scheduler ──▶ key #17 ──▶ https://api.upstream.com/v1
                (one token)              │ 429? 5xx? retry with another key
                                         └──▶ key #4  ──▶ ✓
```

## Features

- **One URL, many keys** — expose a single OpenAI-compatible `/v1` endpoint backed by any number of upstream API keys, batch-imported one per line.
- **Automatic retry & failover** — on 429 / 5xx / network errors the request is transparently retried with a different key. `Retry-After` is honored, rate-limited keys go into exponential-backoff cooldown, keys that return 401 twice are auto-disabled.
- **Six scheduling strategies** — `adaptive` (composite score of success rate × latency × load), `round_robin`, `random`, `weighted`, `least_inflight`, `lowest_latency`.
- **Channels with priority tiers** — group keys into channels (one base URL each) with priority failover, per-channel weight, model whitelists and model-name remapping.
- **Real-time dashboard** — live in-flight request table, per-minute traffic chart, per-key health/latency/429 stats and cooldown countdowns, pushed over SSE.
- **Full web management** — add channels, batch-import keys, enable/disable/test/reset keys, issue client access tokens, tune every scheduler knob — all from the browser, secured by an admin login from env vars.
- **Proxy support** — per-channel outbound HTTP(S) proxy, plus a global fallback (`OUTBOUND_PROXY`).
- **Streaming & usage aware** — SSE responses stream straight through; token usage is extracted from both JSON and streaming responses for stats.
- **Zero-database** — state lives in one JSON file; deploy with Docker in a minute.

## Quick start

### Docker

```bash
docker run -d --name llm-api-pool \
  -p 3000:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=change-me-please \
  -v pool-data:/app/data \
  ghcr.io/emptysuns/llm-api-pool:latest   # or build locally: docker build -t llm-api-pool .
```

### Docker Compose

```bash
git clone https://github.com/emptysuns/llm-api-pool.git
cd llm-api-pool
# edit docker-compose.yml (set ADMIN_PASSWORD!)
docker compose up -d
```

### Node.js (≥ 18.17)

```bash
git clone https://github.com/emptysuns/llm-api-pool.git
cd llm-api-pool
npm ci
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me npm start
```

Then:

1. Open the dashboard at `http://localhost:3000` and log in.
2. **Channels → Add channel** — set the upstream base URL (e.g. `https://api.openai.com`) and paste your API keys, one per line.
3. **Tokens → Create** — issue an access token for your apps.
4. Point your app at the pool:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}'
```

Any OpenAI-compatible SDK works — set `baseURL` to `http://localhost:3000/v1` and `apiKey` to your pool token. Responses carry `x-pool-attempts` and `x-pool-channel` headers for debugging.

## Configuration

All server configuration is via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `ADMIN_USERNAME` | `admin` | Dashboard login user |
| `ADMIN_PASSWORD` | *(empty)* | Dashboard login password. If empty, a random one is generated, persisted and printed to the log |
| `SESSION_SECRET` | *(auto)* | Session-signing secret; auto-generated and persisted if empty |
| `SESSION_TTL_MS` | `86400000` | Admin session lifetime (24 h) |
| `DATA_DIR` | `./data` | Directory for `data.json` (channels, keys, tokens, settings) |
| `OUTBOUND_PROXY` | *(empty)* | Global fallback outbound proxy (`http://host:port`); falls back to `HTTPS_PROXY`/`HTTP_PROXY` |
| `TRUST_PROXY` | *(off)* | Number of reverse-proxy hops to trust (usually `1` behind nginx/traefik) so login rate limiting sees real client IPs; also enables the `Secure` cookie flag via `X-Forwarded-Proto` |
| `BODY_LIMIT_BYTES` | `26214400` | Max `/v1` request body size (25 MB) |

Runtime behavior (strategy, retry counts, timeouts, cooldowns…) is configured in **Settings** in the dashboard:

| Setting | Default | Description |
|---|---|---|
| `strategy` | `adaptive` | Key-selection strategy (see below) |
| `maxAttempts` | `3` | Total tries per request (1 initial + retries), each with a different key |
| `requestTimeoutMs` | `300000` | Upstream response/idle timeout |
| `connectTimeoutMs` | `10000` | Upstream TCP connect timeout |
| `cooldown429BaseMs` | `30000` | Base cooldown after a 429 (doubles per consecutive 429, capped by `cooldownMaxMs`; upstream `Retry-After` wins when present) |
| `cooldownErrorBaseMs` | `5000` | Base cooldown after a 5xx/network error (exponential) |
| `cooldownMaxMs` | `900000` | Cooldown ceiling |
| `disableAfterConsecutiveFailures` | `8` | Auto-disable a key after this many consecutive failures (`0` = never) |
| `retryOn` | `429, 401, 403, 500, 502, 503, 504` | Upstream status codes that trigger failover to another key |
| `allowAnonymous` | `false` | Let clients call `/v1` without a pool access token |
| `logLimit` | `1000` | Finished requests kept in the in-memory log |

## Concepts

- **Channel** — one upstream base URL plus its settings: priority, weight, optional model whitelist, model-name mapping (e.g. rewrite `gpt-4o` → `gpt-4o-2024-08-06` for that upstream), auth header style (`Authorization: Bearer` by default, configurable for other schemes), and an optional per-channel proxy.
- **Key** — an upstream API key inside a channel. Keys are batch-imported one per line; duplicates are skipped. Each key tracks its own health: success/failure counts, 429s, EWMA latency, cooldown state.
- **Access token** — what *your* apps use to call the pool's `/v1` endpoint (`sk-pool-…`). Create/revoke them in the dashboard.

### Scheduling

For each request the pool picks candidates from the **highest-priority tier** of enabled channels that serve the requested model (lower tiers are used only when every key above is cooling down, disabled or already tried), then applies the strategy:

| Strategy | Behavior |
|---|---|
| `adaptive` *(default)* | Weighted-random over a composite score: smoothed success-rate² × latency factor × in-flight penalty × channel weight. Keeps exploring keys while favoring healthy fast ones |
| `round_robin` | Even rotation across keys |
| `random` | Uniform random |
| `weighted` | Random, weighted by channel weight |
| `least_inflight` | Key with the fewest in-flight requests |
| `lowest_latency` | Key with the lowest EWMA latency (new keys first) |

### Retry & key health

- Retryable upstream failures (`retryOn` codes + network errors) trigger an immediate retry with a **different key**; the failing key is benched:
  - **429** → cooldown for `Retry-After` if sent, else exponential backoff starting at `cooldown429BaseMs`.
  - **5xx / network error** → exponential cooldown from `cooldownErrorBaseMs`; after `disableAfterConsecutiveFailures` consecutive errors the key is auto-disabled.
  - **401/403** → treated as a bad key: two consecutive occurrences auto-disable it.
- Non-retryable client errors (400/404/…) pass through unchanged and don't hurt key health.
- If every attempt fails, the last upstream error is returned; if no key is available at all, the pool answers `503` with a JSON error.
- A successful response fully resets the key's failure streaks.

## HTTP API

Everything the dashboard does is a plain REST API you can script against — authenticate with `Authorization: Bearer <session token>` from `POST /api/auth/login`:

```
POST   /api/auth/login              {username, password}
GET    /api/overview
GET    /api/channels                POST /api/channels        PUT/DELETE /api/channels/:id
GET    /api/channels/:id/keys      POST /api/channels/:id/keys   {"keys": "sk-a\nsk-b\n..."}
PATCH  /api/keys/:id               POST /api/keys/:id/reset  POST /api/keys/:id/test
DELETE /api/keys/:id               POST /api/keys/batch-delete   {"ids": [...]}
GET    /api/tokens                  POST /api/tokens          PATCH/DELETE /api/tokens/:id
GET    /api/logs                    GET  /api/requests/live
GET    /api/settings                PUT  /api/settings
GET    /api/events                  (SSE: live request/key/overview events)
```

## Notes

- The pool forwards `/v1/*` verbatim to `<baseUrl>/v1/*` (a trailing `/v1` on the base URL is stripped, so both `https://host` and `https://host/v1` work).
- `Accept-Encoding: identity` is requested upstream so token usage can be read from response bodies.
- API keys are stored in plain text in `DATA_DIR/data.json` — protect that directory. Keys are always masked in the dashboard, logs and API responses unless explicitly revealed.
- Run the pool behind HTTPS (reverse proxy) if it's exposed publicly, and set a strong `ADMIN_PASSWORD`.

## Development

```bash
npm ci
npm test        # unit + integration tests (mock upstream: retries, 429s, streaming, auth)
npm run dev     # auto-restart on change
```

## License

[MIT](LICENSE)
