# 多租户 omp 会话引擎网关 —— 容器镜像
#
# 提供三套运行时，供 agent 在会话里按需调用：
#   - Bun 1.4  ：网关本体（进程内嵌 omp SDK，不起 RPC/子进程）
#   - Node 22  ：npm 生态的 MCP server / 工具链
#   - Conda    ：Python 生态的 MCP server（uv/pip 装包）
#
# 工作区根目录由外部挂载（见 docker-compose.yml 的 WORKSPACE_ROOT → /workspace）：
# 网关的会话 workspace 与状态都落在挂载卷内，宿主机可直接读写、整体搬移（DESIGN §32）。
#
# 构建：docker build -t omp-gateway:latest gateway/
# 运行：docker compose up -d

# ── 基础镜像：Miniconda 提供 conda 环境（python/uv/科学计算栈）────────────────
FROM continuumio/miniconda3:latest

LABEL org.opencontainers.image.title="omp-gateway" \
      org.opencontainers.image.description="Multi-tenant omp session engine gateway (Hono + omp SDK, in-process)" \
      org.opencontainers.image.source="https://github.com/weiwangfds/omp-gateway"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH="/opt/bun/bin:/usr/local/bin:/opt/conda/bin:${PATH}" \
    # npm/conda 不在构建期交互提示
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    CONDA_ALWAYS_YES=true \
    BUN_INSTALL=/opt/bun \
    # 网关进程工作目录：会话 workspace 默认落在这里
    GATEWAY_WORKSPACE_ROOT=/workspace

# ── 系统依赖 ────────────────────────────────────────────────────────────────
# git：workspace 的 git 面；ca-certificates：HTTPS 拉取依赖与回调；
# build-essential/python3-dev：conda 装带原生扩展的包；tini：正确的 PID 1 信号转发；
# unzip/xz-utils/zip：bun 安装脚本与 node 官方包解压需要。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git tini unzip xz-utils zip build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

# ── Bun（网关运行时）────────────────────────────────────────────────────────
ARG BUN_VERSION=1.4.4
RUN mkdir -p /opt/bun \
    && curl -fsSL "https://bun.sh/install" | bash -s "bun-v${BUN_VERSION}" \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun

# ── Node 22 + npm（MCP server 生态）────────────────────────────────────────
# 用 node 官方二进制覆盖基础镜像自带的旧 node；npm 保持随附版本
# （npm@latest 已要求 node ≥22.22，镜像内 node 版本固定 22.x LTS，不必追新）。
ARG NODE_VERSION=22.14.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && /usr/local/bin/node --version && /usr/local/bin/npm --version

# ── Conda 环境（Python 侧 MCP server / 工具）───────────────────────────────
# 预置一个 omp 环境：python 3.12 + pip + uv（uvx 拉 MCP server 常用）
RUN conda create -y -n omp python=3.12 pip \
    && conda clean -afy \
    && /opt/conda/envs/omp/bin/pip install --no-cache-dir uv

# uv 需要在任意 PATH 可达（MCP server 常以 `uvx` 启动）
ENV PATH="/opt/conda/envs/omp/bin:${PATH}"

# 登录 shell（bash -l）会读 profile.d：基础镜像的 conda.sh 会把 PATH 重置回
# /opt/conda/condabin，导致 python/uv 在交互式与 agent 的 bash 工具里不可见。
# 用 zz- 前缀（profile.d 末尾执行）覆盖回我们的顺序。
RUN printf '%s\n' \
      '# 网关镜像运行时 PATH：omp conda 环境 → bun → node/npm → 系统' \
      'export PATH="/opt/conda/envs/omp/bin:/opt/bun/bin:/usr/local/bin:$PATH"' \
      'if [ -f /opt/conda/etc/profile.d/conda.sh ]; then' \
      '  . /opt/conda/etc/profile.d/conda.sh' \
      '  conda activate omp 2>/dev/null || true' \
      'fi' \
      > /etc/profile.d/zz-omp-env.sh

# ── 网关代码 ───────────────────────────────────────────────────────────────
WORKDIR /app/gateway
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

# 预编译校验（构建期就能发现类型错误）
RUN bun run typecheck

# ── 运行时用户与挂载点 ─────────────────────────────────────────────────────
# 非 root 运行；/workspace 由 compose 以宿主目录挂载（属主可能不同，
# 因此容器内 uid 固定为 1000，与常见宿主用户一致）
RUN mkdir -p /workspace /app/gateway/data \
    && chown -R 1000:1000 /app/gateway /workspace \
    && useradd --uid 1000 --create-home --shell /bin/bash omp \
    && chown -R omp:omp /workspace

USER omp
WORKDIR /app/gateway

ENV GATEWAY_PORT=8787 \
    GATEWAY_DATA_ROOT=/workspace/.omp-gateway \
    GATEWAY_EXPORT_DIR=/workspace/.omp-gateway/exports

EXPOSE 8787

# 健康检查：/healthz 无凭据；/readyz 校验数据根可写 + DB 可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/healthz" > /dev/null || exit 1

# tini 做 PID 1：转发 SIGTERM 给 bun，网关的优雅关停（dispose 全部 live 会话）才能跑完
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "src/index.ts"]
