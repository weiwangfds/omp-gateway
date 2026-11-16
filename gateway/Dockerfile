# 多租户 omp 会话引擎网关 —— 容器镜像（多阶段构建）
#
# 提供三套运行时，供 agent 在会话里按需调用：
#   - Bun 1.4  ：网关本体（进程内嵌 omp SDK，不起 RPC/子进程）
#   - Node 22  ：npm 生态的 MCP server / 工具链
#   - Conda    ：Python 生态的 MCP server（uv/uvx 装包；conda 26.7 / python 3.14）
#
# 工作区根目录由外部挂载（见 docker-compose.yml 的 WORKSPACE_ROOT → /workspace）：
# 网关的会话 workspace 与状态都落在挂载卷内，宿主机可直接读写、整体搬移（DESIGN §32）。
#
# 三阶段构建（体积 3.86GB → 1.2xGB，见 DESIGN §35）：
#   base     debian-slim + 自建 Miniconda（installer 按 sha256 固定）→ 只有运行期真需要的系统包
#   builder  装全量依赖（含 devDep）→ 跑 typecheck → 重装生产依赖 → 剔除运行期不加载的文件
#   runtime  只拿运行期需要的东西：bun/node 二进制 + conda(python) + uv + 生产依赖 + 源码
#
# 为什么不用 continuumio/miniconda3：该镜像自带一层 208MB 的 apt 依赖
# （mercurial / subversion / libglib / libsm6 / libxext6 / libxrender1 / python3.13 …），
# 全是 conda 官方示例用的，网关用不到；且官方已宣布该镜像在 Miniconda 26.7.x 后停更。
# 改成在 debian-slim 上跑同一份 Miniconda 安装包：conda 版本、python 版本、包管理器行为完全一致。
#
# 构建：docker build -t omp-gateway:latest gateway/
# 运行：docker compose up -d

# ── 基础层：Debian 13 slim + Miniconda（conda/python 与官方镜像同一份安装包）──────
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS base

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

# bzip2：Miniconda 安装包的解压依赖；ca-certificates/curl：下载安装包 + 运行期回调
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates bzip2 curl \
    && rm -rf /var/lib/apt/lists/*

# Miniconda：按版本号 + sha256 固定，与 continuumio/miniconda3 用的安装包一致
# （conda 26.7.1 / python 3.14）。
#
# 安装 → 清理 → 剥离，全部在同一个 RUN 里：overlayfs 上后续层修改文件会触发 copy-up，
# 同一文件会在两层各存一份（strip 会因此让镜像反而变大）。所以所有"改文件"的动作
# 必须与"创建文件"同层。
#   清理：*.a 静态库、*.js.map、包缓存（/opt/conda/pkgs）、纯文档（gettext/pcre2 的
#         share/doc 就有 15MB）、以及下面这些"装完就没人执行"的东西：
#           _conda             Miniconda 安装器自带的 standalone conda（PyInstaller 打包的
#                              完整 python+conda 副本，59MB），不在 conda 的包清单里；
#                              conda 本体不调用它（已实测 version/list/create --dry-run 全正常）
#           share/info         GNU info 文档
#           share/locale       命令行消息翻译（LANG=C.UTF-8 下永不命中）
#           idlelib            IDLE 图形编辑器（容器内无显示，不可能运行）
#           lib-dynload/_test* CPython 自身的测试扩展模块
#           pcre2test/nghttpx  pcre2 的测试程序、nghttp2 的演示代理（库本体保留）
#           site-packages/**/tests 各包的测试套件（运行期不会被 import）
#   剥离：conda 的二进制/共享库是带 -g 构建的，DWARF + 符号表约 100MB
#         （libpython、python 本体各 28MB，libstdc++ 12MB …），运行期完全用不到——
#         动态链接器只查 .dynsym，strip 不会动它。binutils 同层装完即卸。
ARG MINICONDA_VERSION=py314_26.7.1-1
ARG MINICONDA_SHA256=e8b25b92b262499141c5bd57a98d3c008024185fa951494b9cd9b6d94e72338b
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends binutils; \
    curl -fsSL "https://repo.anaconda.com/miniconda/Miniconda3-${MINICONDA_VERSION}-Linux-x86_64.sh" -o /tmp/miniconda.sh; \
    echo "${MINICONDA_SHA256}  /tmp/miniconda.sh" | sha256sum -c -; \
    bash /tmp/miniconda.sh -b -p /opt/conda; \
    rm -f /tmp/miniconda.sh; \
    /opt/conda/bin/conda tos accept || true; \
    /opt/conda/bin/conda remove --force-remove -y conda-anaconda-tos || true; \
    rm -rf /root/.conda/tos; \
    find /opt/conda -follow -type f -name '*.a' -delete; \
    find /opt/conda -follow -type f -name '*.js.map' -delete; \
    /opt/conda/bin/conda clean -afy; \
    find /opt/conda/share/doc /opt/conda/share/man -mindepth 1 -delete; \
    rm -f /opt/conda/_conda; \
    rm -rf /opt/conda/share/info /opt/conda/share/locale /opt/conda/lib/python3.14/idlelib; \
    rm -f /opt/conda/lib/python3.14/lib-dynload/_test*.so \
          /opt/conda/lib/python3.14/lib-dynload/xxlimited*.so \
          /opt/conda/lib/python3.14/lib-dynload/_ctypes_test*.so \
          /opt/conda/bin/pcre2test /opt/conda/bin/nghttpx; \
    find /opt/conda/lib/python3.14/site-packages -maxdepth 3 -type d \
        \( -name test -o -name tests \) -prune -exec rm -rf {} +; \
    find /opt/conda -type f \( -name '*.so' -o -name '*.so.*' \) \
        -exec strip --strip-unneeded {} + 2>/dev/null || true; \
    find /opt/conda/bin -maxdepth 1 -type f \
        -exec strip --strip-unneeded {} + 2>/dev/null || true; \
    apt-get purge -y --auto-remove binutils; \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ═══════════════════════════════════════════════════════════════════════════
# 阶段 1：builder —— 依赖安装 + 类型检查 + 产出生产依赖
# ═══════════════════════════════════════════════════════════════════════════
FROM base AS builder

# 构建期工具链只在这一层；omp 的原生模块是预编译的（pi-natives-linux-x64），
# 不需要 gcc/python3-dev。git 供 bun install 拉 git 依赖。
RUN apt-get update && apt-get install -y --no-install-recommends \
        git unzip xz-utils zip binutils \
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
    && rm -rf /opt/node/include \
    # 官方 node 二进制带符号表（.symtab 13MB + DWARF 2MB），运行期只用 .dynsym
    && strip --strip-unneeded /opt/node/bin/node \
    # npm 自带的文档/手册页（2.7MB），`npm help` 用；`npm install` 不受影响
    && rm -rf /opt/node/lib/node_modules/npm/docs /opt/node/lib/node_modules/npm/man

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
              node_modules/puppeteer-core node_modules/chromium-bidi \
    # puppeteer-core 移除后残留的传递依赖（仅浏览器特性使用）
              node_modules/@puppeteer node_modules/devtools-protocol \
              node_modules/webdriver-bidi-protocol \
    # 类型声明（.d.ts）只在 tsc 阶段有用：运行时走 package.json 的 import 条件
    # （指向 src/*.ts），构建期 typecheck 已在上面完成
    && rm -rf node_modules/@oh-my-pi/*/dist/types

# ═══════════════════════════════════════════════════════════════════════════
# 阶段 2：runtime —— 只保留运行期需要的东西
# ═══════════════════════════════════════════════════════════════════════════
FROM base AS runtime

# 运行时系统依赖（与改造前的能力对齐）：
#   git / openssh-client —— workspace 的 git 面（含 git+ssh）
#   curl / ca-certificates —— 健康检查与 HTTPS 回调
#   procps —— agent 的 shell 工具常用 ps
#   wget / bzip2 —— 会话内下载与解压
#   tini —— PID 1，转发 SIGTERM 让优雅关停跑完
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client bzip2 procps wget tini \
    && rm -rf /var/lib/apt/lists/*

# Bun 二进制（builder 已装好，直接取；不含安装器缓存）
COPY --from=builder /opt/bun/bin/bun /usr/local/bin/bun

# Node 22 + npm（npm 侧 MCP server 需要）
COPY --from=builder /opt/node /opt/node

# Python 侧工具链：uv / uvx（Python MCP server 的包管理与 Python 版本管理）。
# 不另建独立 conda env（与基础镜像自带的 python 重复）：base 已提供 conda（python 3.14）；
# 需要特定 Python 版本的 MCP server 由 uvx 自行获取（uv python install），无需预置。
ARG UV_VERSION=0.13.8
ENV UV_INSTALL_DIR=/usr/local/bin
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh \
    && uv --version && uvx --version \
    && rm -rf /root/.cache /root/.local/share

# 登录 shell（bash -l）会读 profile.d：conda.sh 会把 PATH 重置回 /opt/conda/condabin，
# 导致 python/uv 在交互式与 agent 的 bash 工具里不可见。
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
