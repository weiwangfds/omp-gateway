# 网关运维手册（SOP）

面向部署与接入方：怎么把网关跑起来、怎么接、怎么运维、怎么迁移。
设计语义与取舍见 [`DESIGN.md`](./DESIGN.md)；机器可读契约见运行时 `GET /openapi.json`；
端点清单见 [`endpoint-index.md`](./endpoint-index.md)（由 openapi 派生）；
事件类型见 [`../contracts/gateway-events.v1.schema.json`](../contracts/gateway-events.v1.schema.json)；
错误码见 [`../contracts/error-codes.md`](../contracts/error-codes.md)；
集成端调用细节见 [`../contracts/integration-guide.md`](../contracts/integration-guide.md)。

## 0. 五分钟认识网关

网关是**内网服务**，不直接暴露公网，也不持有用户体系：

```
React(前端)  ──►  Python 业务后端  ──►  omp 网关  ──►  (进程内 AgentSession × N)
                  (持有用户/认证/业务)   (只做引擎)
```

- 上游注入两个头即可调用：`Authorization: Bearer <svc-token>` + `X-User-Id: <用户标识>`。
- 网关按 `X-User-Id` 隔离一切：模型目录、凭据、skills、插件、MCP、会话、workspace、快照。
- 一次对话的最小序列：**建会话 → 订阅 SSE → 发 prompt → 消费事件**。

```bash
TOKEN=your-service-token
BASE=http://127.0.0.1:8787

SID=$(curl -s -X POST $BASE/api/sessions \
  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" -H 'Content-Type: application/json' \
  -d '{"model":{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}}' | jq -r .id)

curl -N $BASE/api/sessions/$SID/events -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" &
curl -s -X POST $BASE/api/sessions/$SID/prompt \
  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" -H 'Content-Type: application/json' \
  -d '{"text":"写一个贪心排序并跑测试"}'
```

## 1. 部署

### 1.1 Docker（推荐）

镜像内置四套运行时：**Bun**（网关本体）、**Node 22 + npm**（npm 生态 MCP server）、
**Conda**（自建 Miniconda，conda 26.7 / python 3.14）、**uv/uvx**（Python 侧 MCP server 的包管理与
Python 版本管理）。工作区根目录由宿主机挂载进容器，容器内的会话产出与状态都落在挂载卷里，
宿主机可直接读写。

镜像为**三阶段构建，体积 1.65GB**（首版单阶段 3.86GB，逐步处置见 DESIGN §35）：构建期工具链、
bun 下载缓存、devDependencies、omp 交互式 TUI/浏览器前端依赖、conda 的调试符号与文档、
类型声明都不进最终镜像；构建阶段会跑 `bun run typecheck`，类型错误在 `docker build` 时就暴露。

```bash
cd gateway && docker build -t omp-gateway:latest .

# 工作区根目录（宿主机路径）→ /workspace（容器内）
export WORKSPACE_ROOT=/srv/omp-workspace
export GATEWAY_SERVICE_TOKENS=change-me-service-token
docker run -d --name omp-gateway -p 8787:8787 \
  -e GATEWAY_SERVICE_TOKENS="$GATEWAY_SERVICE_TOKENS" \
  -e GATEWAY_DATA_ROOT=/workspace/.omp-gateway \
  -v "$WORKSPACE_ROOT:/workspace" \
  omp-gateway:latest
```

或用 compose（`docker-compose.yml` 已把上述参数固化）：

```bash
WORKSPACE_ROOT=/srv/omp-workspace \
GATEWAY_SERVICE_TOKENS=change-me-service-token \
docker compose up -d
```

容器内路径约定：

| 路径 | 内容 | 宿主机可见 |
|---|---|---|
| `/workspace` | 工作区根目录（挂载点） | 是 |
| `/workspace/.omp-gateway` | `gateway.db` + `users/<uid>/`（会话、workspace、快照、agentDir） | 是 |
| `/workspace/.omp-gateway/exports` | 环境迁移 bundle | 是 |
| `/app/gateway` | 网关代码（只读运行） | 否 |

容器内可用：`python`（conda base，3.14）、`uv`/`uvx`、`node`/`npm`、`bun`、`git`。
MCP server 若需要特定 Python 版本，由 uvx 自行获取（`uvx --python 3.12 …`），无需在镜像里预置。

> 挂载点属主与容器内 uid（1000）不一致时，容器内写入会 EACCES。用 `docker exec -u 0` 修一次属主即可。

### 1.2 本机运行

```bash
cd gateway
cp .env.example .env          # 至少设置 GATEWAY_SERVICE_TOKENS
bun install
bun dev                       # http://127.0.0.1:8787
```

需要 Bun ≥ 1.2（`Bun.YAML`）。生产用 `bun run src/index.ts`，`SIGINT`/`SIGTERM` 会触发优雅关停
（先封闸再 dispose 全部 live 会话）。

### 1.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_PORT` | 8787 | 监听端口 |
| `GATEWAY_SERVICE_TOKENS` | 空（必填） | 服务间 token，逗号分隔支持轮换窗口；为空直接拒绝启动 |
| `GATEWAY_DATA_ROOT` | `<repo>/data` | 数据根：`gateway.db` + `users/<uid>/` + `global/` |
| `GATEWAY_DEFAULT_MAX_SESSIONS` | 50 | 每用户活跃会话上限（懒 provision 时的默认值） |
| `GATEWAY_DEFAULT_MAX_CONCURRENT` | 10 | 每用户**同时**跑的会话/流式数 |
| `GATEWAY_MAX_GLOBAL_STREAMING` | 50 | 全局流式槽位；超出排队 60s 后 429 |
| `GATEWAY_STREAM_QUEUE_TIMEOUT_MS` | 60000 | 排队超时（429 + `Retry-After`） |
| `GATEWAY_STREAM_MAX_HOLD_MS` | 600000 | 槽位最长持有（防泄漏兜底） |
| `GATEWAY_SESSION_IDLE_TTL_MS` | 1800000 | 空闲回收 TTL（无订阅者且 idle） |
| `GATEWAY_BACKUP_DIR` / `_INTERVAL_MIN` | 空 / 60 | 定时 `VACUUM INTO` 快照目录与间隔 |
| `GATEWAY_EXPORT_DIR` | `<dataRoot 同级>/gateway-exports` | 环境迁移 bundle 导出目录 |
| `GATEWAY_IMPORT_DIRS` | 同导出目录 | 导入允许读取的根（逗号分隔，防目录穿越） |
| `GATEWAY_WEBHOOK_HOSTS_ALLOWLIST` | 空（放行） | 回调目标 host 白名单（SSRF 收紧） |
| `GATEWAY_CORS_ORIGINS` | 空（关闭） | 浏览器直连白名单；默认 BFF 代理架构无需开启 |
| `GATEWAY_OTEL` | 0 | 打开 SDK telemetry（无 OTEL SDK 注册时为 no-op） |
| `GATEWAY_TRASH_TTL_DAYS` | 30 | trash 物理清除窗口 |

限额改法有三条，优先级从高到低：`PATCH /internal/users/:uid/limits`（单用户）→
`GATEWAY_DEFAULT_*`（全局默认）→ `tenants.limits_json`（DB 持久化）。

### 1.4 内网部署：包管理器镜像源

内网机器通常只有 **conda / pip / npm** 镜像；公网源（包括 uv 的默认索引和它的 Python 解释器下载）
不可达。镜像启动时会把这些环境变量固化成 `$HOME` 下的配置，**只影响会话里现装的包**
（agent 的 `pip`/`npm`、MCP server 的 `npx`/`uvx`/`conda`），镜像自带的依赖不受影响。
一个都不设 = 一行都不写，保持上游默认行为。

| 变量 | 落到 | 作用 |
|---|---|---|
| `PIP_INDEX_URL` | `~/.config/pip/pip.conf` | pip 主源；**也是 uv 的默认索引** |
| `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` / `PIP_CERT` | 同上 | 附加源 / http 或自签源 / 自签 CA |
| `NPM_CONFIG_REGISTRY` | `~/.npmrc` | npm、npx 源 |
| `CONDA_CHANNELS` / `CONDA_DEFAULT_CHANNELS` | `~/.condarc` | conda 搜索源 / 把 `defaults` 也指到镜像 |
| `UV_DEFAULT_INDEX` | `~/.config/uv/uv.toml` | uv 索引；不设则跟随 `PIP_INDEX_URL` |
| `UV_PYTHON_INSTALL_MIRROR` | 同上 | uv 装 Python 解释器的镜像（默认去 GitHub） |
| `UV_PYTHON_DOWNLOADS=never` | 同上 | 禁止 uv 下载解释器，只用镜像自带 conda python 3.14 |
| `UV_SYSTEM_CERTS=1`（旧名 `UV_NATIVE_TLS`） | 同上 | uv 用系统证书库（内网 CA 已装进系统时） |
| `UV_INSECURE_HOST` | 同上 | 指定 host 跳过 TLS 校验（自签且不想配 CA 时） |

配置文件权限 `600`（源地址里可能带 token）；同时写 `~/.config/omp/env.sh`，登录 shell 自动 source，
所以 `docker exec -it omp-gateway bash -l` 与 agent 的 bash 工具看到的是同一套配置。

最小内网配置（写进 compose 的 `.env`）：

```bash
PIP_INDEX_URL=https://nexus.internal/repository/pypi-proxy/simple
NPM_CONFIG_REGISTRY=https://nexus.internal/repository/npm-proxy/
CONDA_CHANNELS=https://nexus.internal/repository/conda-main
# uv 索引自动跟随 PIP_INDEX_URL；解释器二选一：
UV_PYTHON_DOWNLOADS=never
# UV_PYTHON_INSTALL_MIRROR=https://nexus.internal/python-build-standalone
```

自检（容器内，四条都应通过）：

```bash
docker exec omp-gateway bash -lc '
  pip config list
  npm config get registry
  conda config --show channels default_channels
  uvx --python 3.14 --from pygments pygmentize -V    # 走内网索引 + 系统 python，不下载解释器
  pip download --no-deps -d /tmp/x six -v | head -1  # 第一行应显示内网 index
'
```

三个内网特有的注意点：

1. **uvx 的解释器**：`uvx --python 3.12` 默认去 GitHub 下载 python-build-standalone，内网必失败。
   给 `UV_PYTHON_INSTALL_MIRROR`，或用 `UV_PYTHON_DOWNLOADS=never` 只用镜像自带的 3.14
   （`uvx --python 3.14 …` 已实测可用）。
2. **只装 wheel**：镜像里没有编译器，pip/uv 遇到只有 sdist 的包会失败——内网镜像需提供 wheel。
3. **镜像本身怎么进内网**：`Dockerfile` 构建要拉 debian / bun / node / miniconda，内网一般拉不到。
   在有网机器上 `docker build` 后 `docker save omp-gateway:latest | gzip > omp-gateway.tar.gz`，
   内网 `docker load` 即可；只在有网机器上装一次，之后升级同样走 tar。

## 2. 接入（上游侧）

### 2.1 身份与凭据

| 场景 | 头 | 权限 |
|---|---|---|
| 上游业务后端 | `Authorization: Bearer <svc-token>` + `X-User-Id` | 全权（该用户全部面） |
| 分享链接访问 | `X-Share-Token` | 绑定单会话；`view` 只读，`control` 可写对话动作 |
| 全局资源管理 | `Authorization` + `X-Admin-Id` | `/admin/global/*`；网关只认标识，权限判定在上游 |

分享令牌**不能**访问 `/internal/*` 与 `/api/me/*`（配置面），命中返回 403 `SHARE_TOKEN_FORBIDDEN`。

### 2.2 四件事怎么落地

| 能力 | 端点 | 要点 |
|---|---|---|
| 提示词注入 | 创建期 `POST /api/sessions` 带 `{appendSystemPrompt, contextFiles}`；运行期 `POST /:sid/inject` | `mode=context` 不耗模型不触发 turn；`mode=user` 触发 turn（计 RPM/预算） |
| 取状态 | `GET /:sid/bootstrap`（一次拿全）/ `GET /:sid/status`（轻量轮询） | bootstrap 含 `latestSeq`，用来对齐 SSE 游标 |
| 收事件 | `GET /:sid/events`（SSE）/ `GET /:sid/events/replay`（JSON 回放） | **先订阅后 prompt**；重连带 `Last-Event-ID` |
| 收回调 | `POST /api/me/webhooks`（用户级）/ `POST /:sid/webhooks`（会话级） | HMAC-SHA256 签名（头 `x-omp-signature`），secret 仅创建响应返回一次 |

### 2.3 事件与断线

- SSE 帧：`id:`=会话内单调序号，`event:`=事件类型，`data:`=单行 JSON。
- 重连：`Last-Event-ID` 头 → 网关回放该序号之后的**消息/工具类**事件，随后 `replay.state` 状态帧。
- 过滤：`GET /:sid/events?types=text.delta,tool.*`（后缀通配）；`replay.state` 与 `error` 永远放行。
- 环形缓冲只保留最近 500 条；更早的历史走 `GET /:sid/messages` 或 `GET /:sid/entries`。
- `event: error` 帧表示会话不可用（`NOT_FOUND` / `SESSION_NOT_LIVE`），收到后应停止重连。

### 2.4 幂等与重试

写操作用 `Idempotency-Key`（24h 窗口内同 user+scope 重放同响应，仅缓存 2xx）：
`POST /api/sessions`、`POST /:sid/snapshots`。重试用同一个 key 即可安全重发。

429 响应带 `Retry-After`：RPM 超限（`RATE_LIMITED`）与流式排队超时（`STREAM_QUEUE_TIMEOUT`）分别退避。

## 3. 日常运维

### 3.1 探针与指标

| 端点 | 用途 | 语义 |
|---|---|---|
| `GET /healthz` | 存活 | drain 期间返回 503（摘流量） |
| `GET /readyz` | 就绪 | 写数据根探针：不可写 → 503 |
| `GET /metrics` | Prometheus | live/streaming 会话数、流式槽位、排队数、用量与成本累计、限流/预算拒绝计数 |
| `GET /openapi.json` | 契约 | 运行时生成，193 个操作 |

### 3.2 排空（滚动发布）

```bash
curl -X POST $BASE/internal/drain -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"
# → {"draining":true}；healthz 变 503，上游应切流到其他实例
curl -X POST "$BASE/internal/drain?off=1" ...   # 恢复接单
```

drain 只拒新会话并让健康检查失败；**已有会话继续跑完**。滚动发布的正确顺序：
先 drain → 等 `omp_gateway_sessions_live` 归零 → 停容器 → 启动新实例 → 新实例接流。

### 3.3 定时任务

| 作业 | 周期 | 行为 |
|---|---|---|
| IdleCuller | 60s | idle 且无 SSE 订阅超 TTL → dispose 进程态（文件保留，下条消息按 sessionFile 秒级复活） |
| SnapshotPruner | 10min | auto 快照 ring 滚动（K=20）+ manual TTL 90 天 + 孤儿文件清理 |
| TrashPurger | 10min | deleted 超 TTL 的会话/租户物理清除 |
| Backup | 60min（可配） | `VACUUM INTO` 一致快照到 `GATEWAY_BACKUP_DIR`，保留最近 8 份 |

### 3.4 会话生命周期

| 动作 | 端点 | 语义 |
|---|---|---|
| 归档 | `PATCH /api/sessions/:sid {"status":"archived"}` | 释放进程态，文件保留；归档会话只读（写操作 409 `SESSION_ARCHIVED`） |
| 删除 | `DELETE /api/sessions/:sid?confirm=<sid>` | 先打 `pre_delete` 快照 → 进 trash 30 天 → 物理清除 |
| 找回 | `POST /internal/trash/sessions/:sid/restore` | 清 `deleted_at`，状态回 active |
| 级联删用户 | `DELETE /internal/users/:uid?confirm=<uid>` | dispose 全部 live → 标记 deleted（30 天后物理清除） |

### 3.5 故障速查

| 症状 | 原因 | 处理 |
|---|---|---|
| 建会话 409 `MODEL_NOT_FOUND` | 该用户 `models.yml` 无此模型 | `PUT /api/me/models/config` 配模型 + `POST /api/me/models/credentials` 注入凭据 |
| 建会话 409 `MODEL_UNAVAILABLE` | 会话文件引用的模型已失效 | `POST /:sid/model` 切到可用模型 |
| prompt 409 `MODEL_UNAVAILABLE` | 会话无模型 | 同上；创建时带 `model` |
| prompt 429 `STREAM_QUEUE_TIMEOUT` | 流式槽位排队超时 | 按 `Retry-After` 退避；调大 `GATEWAY_MAX_GLOBAL_STREAMING` |
| 建会话 429 `RATE_LIMITED` | RPM 超限 | 退避；或调 `limits.rpm` |
| 建会话 402 `BUDGET_EXCEEDED` | 月度预算耗尽 | 上游调 `PATCH /internal/users/:uid/limits` 的 `monthlyBudgetUsd` |
| 工具调用挂住等审批 | 审批策略为 always-ask 且未决策 | SSE `tool.confirm_required` → `POST /:sid/approvals/:id {"approve":true}`；超时后端自动拒绝 || 事件不来了 | 未先订阅 SSE | 先 `GET /:sid/events` 建立订阅再 `POST /:sid/prompt`（协议要求） |
| 404 `NOT_FOUND` 查不到会话 | 跨租户或已删除 | 网关不区分"不存在"与"无权访问"（防枚举） |
| MCP 工具不出现 | `enableMcp=false` 或 `mcp.json` 未合成 | `POST /:sid/mcp/reload`；检查 `GET /api/me/mcp` |

## 4. 环境迁移（换机 / 换盘 / 蓝绿切换）

设计见 [`DESIGN.md` §32](./DESIGN.md)。**可迁移单元 = dataRoot 整棵树**（`gateway.db` + `users/` +
`global/`），DB 内路径存相对路径，换机后无需改写任何记录。

### 4.1 方式 A：整目录拷贝（最简单）

```bash
# 旧机：停服务后整目录拷走
rsync -a /srv/omp-workspace/ new-host:/srv/omp-workspace/

# 新机：指向新路径启动即可（GATEWAY_DATA_ROOT 可以不同）
GATEWAY_DATA_ROOT=/srv/omp-workspace/.omp-gateway bun run src/index.ts
```

### 4.2 方式 B：bundle 导出/导入（可跨机、可回滚）

```bash
# 导出（自动 drain 并 dispose 全部 live 会话，保证 DB 快照与文件树一致）
curl -X POST $BASE/internal/maintenance/export -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"
# → {"bundlePath":"/workspace/.omp-gateway/exports/export-…","manifest":{…}}

# 把 bundle 目录拷到目标机（或两台共享同一挂载卷）
# 目标机导入（path 必须在 GATEWAY_IMPORT_DIRS 白名单内）
curl -X POST $BASE/internal/maintenance/import \
  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops" \
  -H 'Content-Type: application/json' \
  -d '{"path":"/workspace/.omp-gateway/exports/export-…","confirm":"REPLACE"}'
# → {"ok":true,"counts":{…},"backupDir":"/workspace/.omp-gateway.bak-…"}
```

导入语义：先校验 manifest + `gateway.db` 的 sha256 → 静默本实例 → **复制覆盖**（不做目录 rename：
Windows 绑定挂载上 rename 会 EACCES）→ 按 manifest 的文件清单删掉本地多余文件 → 换库重开 →
计数对账。导入前的环境复制到 `<dataRoot>.bak-<ts>` 备查，确认无误后手动删除。

| 错误码 | 含义 |
|---|---|
| `MANIFEST_INVALID` | manifest 缺失/格式不符 |
| `SCHEMA_VERSION_MISMATCH` | bundle 的 DB 版本高于当前网关 |
| `BUNDLE_INCOMPLETE` | `gateway.db` 校验和不符或缺 `users/`、`global/` |
| `PATH_FORBIDDEN` | bundle 路径不在白名单内 |
| `MAINTENANCE_BUSY` | 另一个导出/导入进行中 |

### 4.3 灾备

`GATEWAY_BACKUP_DIR` 的定时 `VACUUM INTO` 快照是**数据库**级备份；文件树要另外备份
（`users/` + `global/`）。整体恢复按方式 A 处理。

## 5. 安全基线

- 网关只在内网暴露；`GATEWAY_SERVICE_TOKENS` 用强随机值并支持双 token 轮换窗口。
- 上游负责用户认证与权限判定；网关只认 `X-User-Id` 的**格式**与资源归属。
- `GATEWAY_WEBHOOK_HOSTS_ALLOWLIST` 收紧回调目标（SSRF 防护）。
- 文件路径三重守卫：词法前缀 + realpath 符号链接检查 + 用户根限制。
- `models.yml` 含明文 API key：`/api/me/*` 仅全权 svc-token 可读，分享令牌一律 403。
- `X-Admin-Id` 只作标识记录，不构成授权——真正的权限判定在上游。
- 管理动作全部落 `audit_log`（`GET /internal/audit` 查询）。

## 6. 排障工具箱

```bash
# 看审计
curl "$BASE/internal/audit?user=u_42&page=1" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"

# 看用量（day/model/session 分桶）
curl "$BASE/internal/users/u_42/usage?group=model" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"

# 看会话现状
curl "$BASE/api/sessions/:sid" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42"
curl "$BASE/api/sessions/:sid/state"  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42"

# 审批清单（确认是否卡住）
curl "$BASE/api/sessions/:sid/approvals" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42"

# 队列与任务（队列用 DELETE 整清，单条删除见 POST /:sid/queue/remove）
curl -X DELETE "$BASE/api/sessions/:sid/queue" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42"
curl "$BASE/api/sessions/:sid/jobs"  -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42"
```

开发期诊断开关：`GATEWAY_HOOKS_DEBUG=1` 会在 stderr 打印钩子分发链路（身份映射、命中数量）。

## 7. 开发与发布

```bash
cd gateway
bun run typecheck     # tsc strict + noUnusedLocals/Parameters
bun run lint          # Biome 2.6（0 诊断为准）
bun run lint:fix      # 自动修
bun run test          # 串行全量（Bun 默认并行会争抢端口）
```

测试分两类：**离线**（不调模型，覆盖网关语义）与 **e2e**（需要真实模型凭据，缺凭据自动跳过）。
改动数据层或路由后必须跑全量；`bun test` 直跑会并行起多个网关进程，偶发 ECONNREFUSED——
用 `bun run test`（串行 runner）。

发布检查表：

1. `bun run lint` 与 `bun run typecheck` 零诊断；
2. `bun run test` 全绿（28 个文件，约 296 项）；
3. 契约变更同步 `contracts/`（事件 schema、错误码）与 `docs/DESIGN.md`；
4. 新增/改动路由后跑 `bun run scripts/gen-endpoint-index.mjs` 重新生成端点索引；
5. `GET /openapi.json` 的摘要覆盖率必须 100%（`x-gateway-coverage.summaryCoverage`），
   由 `test/detailed-endpoints.test.ts` 守住；
6. 容器化验证：`docker build` + `scripts/docker-smoke.mjs`（15 项，含导出导入往返）。

## 8. 任务手册

按“要做什么”查步骤。每条都是可直接执行的命令序列。

### 8.1 让一个新用户能用上模型

```bash
# 1) provision（建目录骨架 + 租户行，幂等）
curl -X POST $BASE/internal/users/u_42/provision -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"

# 2) 配置模型目录（结构化 JSON；网关会格式化落盘）
curl -X PUT $BASE/api/me/models/config -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{
    "providers": { "minimax": {
      "baseUrl": "https://api.minimax.cn/v1", "api": "openai-completions",
      "models": [{ "id": "MiniMax-M3.1-Flash", "name": "MiniMax M3.1 Flash" }] } } }'

# 3) 注入凭据（值可以是环境变量名，也可以是字面量）
curl -X POST $BASE/api/me/models/credentials -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{"provider":"minimax","apiKey":"MINIMAX_API_KEY"}'

# 4) 验证：目录里应出现该模型
curl "$BASE/api/me/models" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" | jq '.models[].modelId'

# 5) 可选：探针实测一次（独立内存会话，测首字延迟）
curl -X POST $BASE/api/me/models/test -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{"provider":"minimax","modelId":"MiniMax-M3.1-Flash"}'
```

### 8.2 让业务系统接管一次对话（集成端最小闭环）

```bash
# 1) 建会话（带业务上下文文件；不落盘，只进系统提示词）
SID=$(curl -s -X POST $BASE/api/sessions -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{
    "model": {"provider":"minimax","modelId":"MiniMax-M3.1-Flash"},
    "contextFiles": [{"path":"AGENTS.md","content":"你是订单助手"}] }' | jq -r .id)

# 2) 订阅事件（先订阅后 prompt，否则会丢开头事件）
curl -N "$BASE/api/sessions/$SID/events" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" &

# 3) 发指令（202 立即返回；结果在 SSE 里）
curl -X POST "$BASE/api/sessions/$SID/prompt" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{"text":"查一下订单 12345"}'

# 4) 无 SSE 能力的集成端：加 wait=true 同步等终态
curl -X POST "$BASE/api/sessions/$SID/prompt" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{"text":"查一下订单 12345","wait":true,"waitTimeoutMs":120000}'
```

### 8.3 把业务函数暴露成 agent 工具

```bash
# 1) 注册（JSON Schema 描述入参；网关在模型调用时 POST 你的端点）
curl -X PUT $BASE/api/me/tools/http/order_status -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{
    "description": "查询订单状态",
    "url": "https://biz.internal/tools/order_status",
    "parameters": {"type":"object","properties":{"orderId":{"type":"string"}},"required":["orderId"]},
    "timeoutMs": 10000 }'

# 2) 业务端点实现约定
#    请求：POST {"toolCallId","name","args","sessionId","userId"}
#    响应：{"text":"..."} 或 {"content":[{"type":"text","text":"..."}]}
#    校验：x-omp-signature = HMAC-SHA256(secret, 原始 body)

# 3) 热生效：注册后当前 live 会话立即可用（refreshMCPTools），新会话自动注入
```

### 8.4 在决策点拦截 agent（同步决策钩子）

```bash
# 注册 decide 型钩子：tool_call 事件，网关等你的响应决定放行/改参/拦截
curl -X POST $BASE/api/sessions/$SID/hooks -H "Authorization: Bearer $TOKEN" -H "X-User-Id: u_42" \
  -H 'Content-Type: application/json' -d '{
    "event": "tool_call", "mode": "decide",
    "url": "https://biz.internal/hooks/tool_call",
    "timeoutMs": 3000, "onTimeout": "deny",
    "matcher": {"tool": "bash"} }'

# 你的响应体（语义对齐 omp hooks）：
#   {"block": true, "reason": "不允许写生产配置"}
#   {"input": {"command": "ls"}}          # 改参
#   {"additionalContext": "用 dry-run"}   # 追加上下文
```

### 8.5 审计与合规

```bash
# 某用户的所有变更动作
curl "$BASE/internal/audit?user=u_42&per_page=200" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"

# 某类动作（如删除）
curl "$BASE/internal/audit?action=session.delete" -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops"
```

### 8.6 扩容一个用户

```bash
# 提高该用户的会话数与并发数（合并语义，不影响其他字段）
curl -X PATCH $BASE/internal/users/u_42/limits -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops" \
  -H 'Content-Type: application/json' -d '{"maxSessions":100,"maxConcurrent":20}'

# 只放开某个 provider
curl -X PATCH $BASE/internal/users/u_42/limits -H "Authorization: Bearer $TOKEN" -H "X-User-Id: ops" \
  -H 'Content-Type: application/json' -d '{"allowedProviders":["minimax","anthropic"]}'
```

## 9. 参考

| 主题 | 文档 |
|---|---|
| 完整设计与取舍 | [`DESIGN.md`](./DESIGN.md) |
| 端点清单（193 个操作，含查询参数） | [`endpoint-index.md`](./endpoint-index.md) |
| 集成端调用细节（python/go/ts） | [`../contracts/integration-guide.md`](../contracts/integration-guide.md) |
| 事件契约 | [`../contracts/gateway-events.v1.schema.json`](../contracts/gateway-events.v1.schema.json) |
| 前端事件映射 | [`../contracts/frontend-mapping.md`](../contracts/frontend-mapping.md) |
| 错误码表 | [`../contracts/error-codes.md`](../contracts/error-codes.md) |
| 运行时契约 | `GET /openapi.json`（OpenAPI 3.1，含 `x-gateway-coverage` 覆盖率自省） |
