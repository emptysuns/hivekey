# HiveKey — CLAUDE.md

Self-hosted LLM API key pool (Express + vanilla JS SPA). No build step, no TypeScript.

## Commands

- `npm start` — run the server (default `http://0.0.0.0:3000`)
- `npm run dev` — run with `--watch`
- `npm test` — Node built-in test runner (`node --test`, files in `test/`)

## Layout

- `src/` — Express backend. `index.js` wires everything; `routes/admin.js` is the admin API; `proxy.js` the `/v1` + `/v1beta` proxy; `adapters.js` translates inbound Anthropic/Responses/Gemini protocols to the OpenAI upstream (requests, responses and SSE streams); `pool.js` channels/keys; `scheduler.js` key selection; `store.js` JSON persistence under `data/`.
- `public/` — dashboard SPA: `index.html` (shell), `app.js` (all views as template strings, event delegation via `data-action`), `style.css`, `i18n.js` (English keys → zh-CN; every user-visible string must go through `t()` and get a zh-CN entry).

## Deployment (IMPORTANT — auto-deploy rule)

Production runs the Docker image `ghcr.io/emptysuns/hivekey:latest`, built for amd64+arm64 by the `Docker` GitHub Actions workflow on every push to `main`.

**Whenever a change is pushed to `main` (i.e. the image gets rebuilt), deploy it to the production server without being asked:**

1. Wait for the `Docker` workflow run for that commit to succeed (`gh run list`).
2. SSH to the production server (address, port and credentials are in `CLAUDE.local.md`, not committed) and run, in the deploy directory: `docker compose pull && docker compose up -d`.
3. Verify: container healthy (`docker compose ps`), then the public URL returns 200.

Server details, credentials and the public URL live in `CLAUDE.local.md` (gitignored — never commit secrets, this repo is public).

@CLAUDE.local.md
