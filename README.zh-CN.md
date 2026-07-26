# hivekey

[English](README.md) | **简体中文**

自托管的 LLM API Key 池。把某个 OpenAI 兼容接口的所有 API Key 放到一个统一 URL 后面,hivekey 会用智能调度算法在这些 Key 之间做负载均衡:遇到 429 或其他错误自动换 Key 重试、按 Key 指数退避冷却、支持出站代理,并提供实时 Web 管理面板。客户端可以用 **OpenAI、Anthropic(Claude)、OpenAI Responses 或 Google Gemini** 任意一种协议调用,池会统一转换到 OpenAI 兼容上游。设计思路参考 [new-api](https://github.com/QuantumNous/new-api)。

```
OpenAI SDK ────▶ /v1/chat/completions ─┐
Claude SDK ────▶ /v1/messages ─────────┤
Codex SDK ─────▶ /v1/responses ────────┼─▶ 调度器 ──▶ key #17 ──▶ https://api.upstream.com/v1
Gemini SDK ────▶ /v1beta/models/…/ ────┘      │ 429? 5xx? 换一个 Key 重试
                    (一个池令牌)               └──▶ key #4  ──▶ ✓
```

## 功能特性

- **一个 URL,多个 Key** —— 对外只暴露一个 OpenAI 兼容的 `/v1` 端点,背后可挂任意数量的上游 API Key,支持每行一个的批量导入。
- **多协议兼容** —— Anthropic SDK(`/v1/messages`,含 `count_tokens`)、OpenAI Responses API(`/v1/responses`)、Google Gemini SDK(`/v1beta/models/{m}:generateContent`)的请求会被透明转换到 OpenAI 上游 —— 非流式和流式都支持,包括工具/函数调用、图片和协议格式的错误响应。
- **自动重试与故障转移** —— 遇到 429 / 5xx / 网络错误时自动换一个 Key 透明重试;尊重 `Retry-After`;被限流的 Key 按指数退避进入冷却;连续两次返回 401 的 Key 自动禁用。
- **八种调度算法** —— 默认为智能调度 `adaptive`(成功率 × 首字延迟 × 吞吐 × 负载的综合评分),另有 `round_robin`、`random`、`weighted`、`least_inflight`、`lowest_latency`、`lowest_ttft`、`highest_throughput`,可在设置页实时切换。
- **性能感知路由** —— 每个请求都会记录首字延迟(TTFT)和每秒 token 数,按 Key 做 EWMA 平滑;这些指标既用于调度,也展示在仪表盘、Key 表格和日志里。
- **渠道与优先级分层** —— 把 Key 按渠道(每个渠道一个 base URL)分组,支持优先级故障转移、渠道权重、模型白名单(支持结尾 `*` 通配符)和模型名映射。
- **实时管理面板** —— 进行中请求实时表格、每分钟流量图表、持久化的每日用量统计、每个 Key 的健康度/延迟/首字/吞吐/429 统计与冷却倒计时,通过 SSE 实时推送。
- **完整的 Web 管理** —— 添加渠道、批量导入 Key、搜索/分页/测试 Key(单个或一键全测)、启用/禁用/重置 Key、签发客户端访问令牌、调整所有调度参数,全部在浏览器里完成。
- **备份与恢复** —— 在设置页把全部配置(渠道、Key、令牌、设置)导出为 JSON,并支持合并或替换两种模式导入。
- **明暗主题** —— 深色 / 浅色 / 跟随系统,一键切换。
- **代理支持** —— 每个渠道可单独设置出站 HTTP(S) 代理,也可配置全局兜底代理(`OUTBOUND_PROXY`)。
- **流式与用量统计** —— SSE 流式响应直接透传;从 JSON 和流式响应中提取 token 用量用于统计。
- **零数据库** —— 所有状态存在一个 JSON 文件里,用 Docker 一分钟即可部署。
- **中英双语面板(i18n)** —— 简体中文与英文,自动跟随浏览器语言,也可一键切换。

## 快速开始

### Docker

```bash
docker run -d --name hivekey \
  -p 3000:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=change-me-please \
  -v pool-data:/app/data \
  ghcr.io/emptysuns/hivekey:latest   # 或本地构建:docker build -t hivekey .
```

### Docker Compose

```bash
git clone https://github.com/emptysuns/hivekey.git
cd hivekey
# 编辑 docker-compose.yml(务必修改 ADMIN_PASSWORD!)
docker compose up -d
```

### Node.js(≥ 18.17)

```bash
git clone https://github.com/emptysuns/hivekey.git
cd hivekey
npm ci
ADMIN_USERNAME=admin ADMIN_PASSWORD=change-me npm start
```

然后:

1. 打开 `http://localhost:3000` 进入管理面板并登录。
2. **Channels → Add channel** —— 填入上游 base URL(如 `https://api.openai.com`),把 API Key 粘贴进去,每行一个。
3. **Tokens → Create** —— 为你的应用签发一个访问令牌。
4. 把应用指向池子:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}'
```

任何 OpenAI 兼容 SDK 都能用——把 `baseURL` 设为 `http://localhost:3000/v1`,`apiKey` 设为你的池令牌。响应头里带有 `x-pool-attempts` 和 `x-pool-channel` 便于调试。

## 使用其他 SDK(Anthropic / Responses / Gemini)

上游渠道保持 OpenAI 兼容即可,池会实时转换这些客户端协议。同一个池令牌在所有端点通用(`Bearer`、`x-api-key`、`x-goog-api-key` 或 `?key=`)。

**Anthropic SDK / Claude Code:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_API_KEY=sk-pool-...
# claude 或任何 Anthropic SDK 现在都会经过池子(POST /v1/messages)
```

**OpenAI Responses API**(如 Codex 类客户端):

```python
client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-pool-...")
client.responses.create(model="gpt-4o", input="hello")
```

**Google Gemini SDK:**

```python
from google import genai
client = genai.Client(api_key="sk-pool-...",
    http_options={"base_url": "http://localhost:3000"})
client.models.generate_content(model="gpt-4o", contents="hello")
```

说明:工具/函数调用、系统提示词、图片(base64)、流式和用量统计都会转换;托管的服务器工具(`web_search` 等)不支持。`/v1/messages/count_tokens` 和 `:countTokens` 由池本地估算返回。

## 配置

服务端配置全部通过环境变量:

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_USERNAME` | `admin` | 面板登录用户名 |
| `ADMIN_PASSWORD` | *(空)* | 面板登录密码。留空时自动生成随机密码,持久化并打印到日志 |
| `SESSION_SECRET` | *(自动)* | 会话签名密钥;留空时自动生成并持久化 |
| `SESSION_TTL_MS` | `86400000` | 管理员会话有效期(24 小时) |
| `DATA_DIR` | `./data` | `data.json`(渠道/Key/令牌/设置)的存储目录 |
| `OUTBOUND_PROXY` | *(空)* | 全局兜底出站代理(`http://host:port`);也会读取 `HTTPS_PROXY`/`HTTP_PROXY` |
| `TRUST_PROXY` | *(关)* | 信任的反向代理跳数(nginx/traefik 之后通常为 `1`),登录限流才能拿到真实客户端 IP;同时通过 `X-Forwarded-Proto` 启用 cookie 的 `Secure` 标志 |
| `BODY_LIMIT_BYTES` | `26214400` | `/v1` 请求体大小上限(25 MB) |

运行时行为(调度算法、重试次数、超时、冷却……)在面板的 **Settings** 里配置:

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `strategy` | `adaptive` | Key 选择策略(见下文) |
| `maxAttempts` | `3` | 每个请求的总尝试次数(1 次初始 + 重试),每次换不同的 Key |
| `requestTimeoutMs` | `300000` | 上游响应/空闲超时 |
| `connectTimeoutMs` | `10000` | 上游 TCP 连接超时 |
| `cooldown429BaseMs` | `30000` | 429 后的基础冷却时间(连续 429 时翻倍,上限 `cooldownMaxMs`;上游带 `Retry-After` 时以其为准) |
| `cooldownErrorBaseMs` | `5000` | 5xx/网络错误后的基础冷却时间(指数增长) |
| `cooldownMaxMs` | `900000` | 冷却时间上限 |
| `disableAfterConsecutiveFailures` | `8` | 连续失败达到该次数后自动禁用 Key(`0` = 从不) |
| `retryOn` | `429, 401, 403, 500, 502, 503, 504` | 触发换 Key 重试的上游状态码 |
| `allowAnonymous` | `false` | 允许不带池令牌直接调用 `/v1` |
| `logLimit` | `1000` | 内存中保留的已完成请求日志条数 |

## 核心概念

- **渠道(Channel)** —— 一个上游 base URL 及其配置:优先级、权重、可选的模型白名单、模型名映射(例如把 `gpt-4o` 改写为该上游的 `gpt-4o-2024-08-06`)、鉴权头样式(默认 `Authorization: Bearer`,可配置成其他方案),以及可选的渠道级代理。
- **Key** —— 渠道内的一个上游 API Key。支持每行一个批量导入,重复的会被跳过。每个 Key 独立跟踪健康状态:成功/失败次数、429 次数、EWMA 延迟、冷却状态。
- **访问令牌(Access Token)** —— *你的*应用调用池 `/v1` 端点所用的令牌(`sk-pool-…`),在面板里创建/吊销。

### 调度

每个请求先从**最高优先级层**中可用的渠道里挑选候选 Key(只有上层全部冷却/禁用/已试过时才降级到下层),然后按策略选择:

| 策略 | 行为 |
|---|---|
| `adaptive` *(默认)* | 按综合评分加权随机:平滑成功率² × 首字延迟因子 × 吞吐因子 × 并发惩罚 × 渠道权重。在偏好健康快速 Key 的同时保持探索 |
| `round_robin` | 轮询 |
| `random` | 均匀随机 |
| `weighted` | 按渠道权重随机 |
| `least_inflight` | 选并发请求最少的 Key |
| `lowest_latency` | 选 EWMA 响应延迟最低的 Key(新 Key 优先) |
| `lowest_ttft` | 选 EWMA 首字延迟最低的 Key(新 Key 优先) |
| `highest_throughput` | 选 EWMA 每秒 token 数最高的 Key(新 Key 优先) |

### 重试与 Key 健康度

- 可重试的上游失败(`retryOn` 中的状态码 + 网络错误)会立即换**另一个 Key** 重试,失败的 Key 被暂时下场:
  - **429** → 有 `Retry-After` 按其冷却,否则从 `cooldown429BaseMs` 开始指数退避。
  - **5xx / 网络错误** → 从 `cooldownErrorBaseMs` 开始指数冷却;连续失败达到 `disableAfterConsecutiveFailures` 次后自动禁用。
  - **401/403** → 视为坏 Key:连续出现两次即自动禁用。
- 不可重试的客户端错误(400/404/……)原样透传,不影响 Key 健康度。
- 所有尝试都失败时返回最后一次上游错误;完全没有可用 Key 时返回 `503` JSON 错误。
- 请求成功会完全重置该 Key 的失败计数。

## HTTP API

面板的所有操作都是普通 REST API,可以直接脚本化——用 `POST /api/auth/login` 拿到会话令牌后以 `Authorization: Bearer <token>` 调用:

```
POST   /api/auth/login              {username, password}
GET    /api/overview
GET    /api/channels                POST /api/channels        PUT/DELETE /api/channels/:id
GET    /api/channels/:id/keys      POST /api/channels/:id/keys   {"keys": "sk-a\nsk-b\n..."}
POST   /api/channels/:id/test-keys  (批量测试渠道内启用的 Key,限并发)
PATCH  /api/keys/:id               POST /api/keys/:id/reset  POST /api/keys/:id/test
DELETE /api/keys/:id               POST /api/keys/batch-delete   {"ids": [...]}
GET    /api/tokens                  POST /api/tokens          PATCH/DELETE /api/tokens/:id
GET    /api/logs                    GET  /api/requests/live
GET    /api/settings                PUT  /api/settings
GET    /api/export                  POST /api/import          {"data": <备份>, "mode": "merge"|"replace"}
GET    /api/events                  (SSE:请求/Key/总览实时事件)
```

## 说明

- 池会把 `/v1/*` 原样转发到 `<baseUrl>/v1/*`(base URL 末尾的 `/v1` 会被自动剥离,所以 `https://host` 和 `https://host/v1` 都可以)。
- 上游请求会带 `Accept-Encoding: identity`,以便从响应体中读取 token 用量。
- API Key 以明文存储在 `DATA_DIR/data.json` 中,请保护好该目录。面板、日志和 API 响应中的 Key 默认全部打码,除非显式选择显示。
- 如果对公网暴露,请置于 HTTPS 反向代理之后,并设置强 `ADMIN_PASSWORD`。

## 开发

```bash
npm ci
npm test        # 单元 + 集成测试(mock 上游:重试、429、流式、鉴权)
npm run dev     # 修改后自动重启
```

## 许可证

[MIT](LICENSE)
