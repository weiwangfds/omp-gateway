# 多租户 omp 会话引擎网关 —— 容器镜像（多阶段构建）
#
# 提供三套运行时，供 agent 在会话里按需调用：
#   - Bun 1.4  ：网关本体（进程内嵌 omp SDK，不起 RPC/子进程）
#   - Node 22  ：npm 生态的 MCP server / 工具链
#   - Conda    ：Python 生态的 MCP server（uv/uvx 装包；conda 用基础镜像自带的）
#
# 工作区根目录由外部挂载（见 docker-compose.yml 的 WORKSPACE_ROOT → /workspace）：
# 网关的会话 workspace 与状态都落在挂载卷内，宿主机可直接读写、整体搬移（DESIGN §32）。
#
# 构建分两阶段（体积从 3.86GB 降到 2.14GB，-44%）：
#   builder  装全量依赖（含 devDep）→ 跑 typecheck → 重装成只含生产依赖的 node_modules
#            → 剔除 TUI/浏览器前端依赖与 node 头文件
#   runtime  只拿运行期需要的东西：bun/node 二进制 + conda(python) + uv + 生产依赖 + 源码
#            （COPY --chown 避免 chown -R 触发 overlayfs copy-up 把依赖再存一份）
#
# 构建：docker build -t omp-gateway:latest gateway/
# 运行：docker compose up -d

# ── 基础镜像：Miniconda 提供 conda 环境（python/uv/科学计算栈）────────────────
FROM continuumio/miniconda3:latest AS base

LABEL org.opencontainers.image.title="omp-gateway" \
      org.opencontainers.image.description="Multi-tenant omp session engine gateway (Hono + omp SDK, in-process)" \
      org.opencontainers.image.source="https://github.com/weiwangfds/omp-gateway"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    CONDA_ALWAYS_YES=true \
    BUN_INSTALL=/opt/bun

# ═══════════════════════════════════════════════════════════════════════════
# 阶段 1：builder —— 依赖安装 + 类型检查 + 产出生产依赖
# ═══════════════════════════════════════════════════════════════════════════
FROM base AS builder

# 构建期工具链只在这一层；omp 的原生模块是预编译的（pi-natives-linux-x64），
# 不需要 gcc/python3-dev。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip xz-utils zip \
    && rm -rf /var/lib/apt/lists/*

# Bun：安装器会把下载缓存放在 /opt/bun/install/cache（数百 MB，与 node_modules
# 内容重复），装完立即删除，只保留二进制。
ARG BUN_VERSION=1.4.4
RUN mkdir -p /opt/bun \
    && curl -fsSL "https://bun.sh/install" | bash -s "bun-v${BUN_VERSION}" \
    && rm -rf /opt/bun/install \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && bun --version

# Node：装到 /opt/node（运行时阶段直接 COPY 过来，避免重下一遍）
ARG NODE_VERSION=22.14.0
RUN mkdir -p /opt/node \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /opt/node --strip-components=1 \
    && PATH=/opt/node/bin:$PATH node --version \
    && PATH=/opt/node/bin:$PATH npm --version \
    # include/ 是编译原生插件用的 C++ 头文件，运行期用不到
    && rm -rf /opt/node/include

WORKDIR /app/gateway
COPY package.json bun.lock bunfig.toml ./
# 第一次安装：全量依赖（含 devDep），供类型检查使用
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
# 构建期门禁：类型错误在镜像构建阶段就暴露
RUN bun run typecheck

# 换成只含生产依赖的 node_modules（去掉 typescript / bun-types / biome 等 devDep）
RUN rm -rf node_modules && bun install --frozen-lockfile --production \
    && rm -rf /opt/bun/install /root/.bun \
    # 剔除只服务于 omp 交互式 TUI / 浏览器特性的前端依赖（约 -100MB）。
    # 网关是 headless 服务：这些包只被 omp-stats（React 面板）与 browser/computer-use
    # 特性引用，SDK 主链路不 import；已用真实模型会话验证（bash 工具调用 + turn.completed 正常）。
    && rm -rf node_modules/lucide-react node_modules/react node_modules/react-dom \
              node_modules/@types/react node_modules/@types/react-dom \
              node_modules/puppeteer-core node_modules/chromium-bidi

# ═══════════════════════════════════════════════════════════════════════════
# 阶段 2：runtime —— 只保留运行期需要的东西
# ═══════════════════════════════════════════════════════════════════════════
FROM base AS runtime

# 运行时系统依赖：git（workspace 的 git 面）、curl（健康检查）、ca-certificates（回调 HTTPS）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git tini \
    && rm -rf /var/lib/apt/lists/*

# Bun 二进制（builder 已装好，直接取；不含安装器缓存）
COPY --from=builder /opt/bun/bin/bun /usr/local/bin/bun

# Node 22 + npm（npm 侧 MCP server 需要）
COPY --from=builder /opt/node /opt/node

# Python 侧工具链：uv / uvx（Python MCP server 的包管理与 Python 版本管理）。
# 不再另建独立的 conda env（+271MB，与基础镜像自带的 python 重复）：
# base miniconda3 已提供 conda（python 3.14）；需要特定 Python 版本的 MCP server
# 由 uvx 自行获取（uv python install），无需在镜像里预置。
ARG UV_VERSION=0.13.8
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh \
    && uv --version && uvx --version \
    && rm -rf /root/.cache /root/.local/share

# 登录 shell（bash -l）会读 profile.d：基础镜像的 conda.sh 会把 PATH 重置回
# /opt/conda/condabin，导致 python/uv 在交互式与 agent 的 bash 工具里不可见。
# 用 zz- 前缀（profile.d 末尾执行）覆盖回我们的顺序。
RUN printf '%s\n' \
      '# 网关镜像运行时 PATH：conda → bun → node/npm → uv → 系统' \
      'export PATH="/opt/conda/bin:/usr/local/bin:/opt/node/bin:$PATH"' \
      'if [ -f /opt/conda/etc/profile.d/conda.sh ]; then' \
      '  . /opt/conda/etc/profile.d/conda.sh' \
      'fi' \
      > /etc/profile.d/zz-omp-env.sh

ENV PATH="/opt/conda/bin:/usr/local/bin:/opt/node/bin:${PATH}" \
    GATEWAY_PORT=8787 \
    GATEWAY_DATA_ROOT=/workspace/.omp-gateway \
    GATEWAY_EXPORT_DIR=/workspace/.omp-gateway/exports

WORKDIR /app/gateway

# 用 --chown 而非 chown -R：后者在 overlayfs 上会把整棵 node_modules 拷进新层（+500MB）
COPY --from=builder --chown=1000:1000 /app/gateway/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/gateway/src ./src
COPY --from=builder --chown=1000:1000 /app/gateway/scripts ./scripts
COPY --from=builder --chown=1000:1000 /app/gateway/package.json ./package.json
COPY --from=builder --chown=1000:1000 /app/gateway/bunfig.toml ./bunfig.toml

# 非 root 运行；/workspace 由 compose 以宿主目录挂载（属主可能不同，
# 因此容器内 uid 固定为 1000，与常见宿主用户一致）
RUN mkdir -p /workspace \
    && useradd --uid 1000 --create-home --shell /bin/bash omp \
    && chown omp:omp /workspace
USER omp

EXPOSE 8787

# 健康检查：/healthz 无凭据；/readyz 校验数据根可写 + DB 可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/healthz" > /dev/null || exit 1

# tini 做 PID 1：转发 SIGTERM 给 bun，网关的优雅关停（dispose 全部 live 会话）才能跑完
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
