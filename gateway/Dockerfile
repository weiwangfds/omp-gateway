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
# 三阶段构建（基础运行时 1.65GB，见 DESIGN §35）：
#   base     debian-slim + 自建 Miniconda（installer 按 sha256 固定）→ 只有运行期真需要的系统包
#   builder  装全量依赖（含 devDep）→ 跑 typecheck → 重装生产依赖 → 剔除运行期不加载的文件
#   runtime  只拿运行期需要的东西：bun/node 二进制 + conda(python) + uv + 生产依赖 + 源码
#
# 在基础之上还有两块可选增强层（默认全量 ≈ 4.3GB，构成见 DESIGN §41）：
#   qmd 层   KB 混合检索引擎（bun 全局装 @tobilu/qmd + provider patch）≈ 0.9GB
#            ——其中 662MB 是 @node-llama-cpp 多平台预编译，QMD_SLIM=1 可裁掉
#              cuda/vulkan/arm* 与 tree-sitter 语法（实测层 907→156MB，见该层注释）
#   pip 层   KB 出图（pymupdf/minio）+ Wren 语义层（wrenai extras）≈ 1.0GB
#            ——WREN_EXTRAS 可按需裁数据源驱动（默认 mcp,postgres,clickhouse）
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
    rm -rf /var/lib/apt/lists/*; \
    # 让容器内的非 root 用户（uid 1000）能 pip/conda install：镜像作为 omp 运行时，
    # agent 会在会话里装包。必须与安装同层（后续层 chown 会 copy-up 整个 /opt/conda）。
    chown -R 1000:1000 /opt/conda

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
    && rm -rf /opt/node/lib/node_modules/npm/docs /opt/node/lib/node_modules/npm/man \
    # 让 uid 1000 能 `npm i -g`（改动同层，运行时 COPY 会保留属主）
    && chown -R 1000:1000 /opt/node

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
    # 剔除只服务于 omp 交互式 TUI 的 React 前端依赖（约 -100MB）。
    # 网关是 headless 服务：这些包只被 omp-stats（React 面板）引用，SDK 主链路不 import。
    # **puppeteer 家族必须保留**（§41.9）：dist/cli.js 顶层静态 import
    # puppeteer-core/internal/util/Function.js——删掉后 omp CLI 在容器内直接
    # MODULE_NOT_FOUND，TUI 终端桥与 RPC/legacy 兼容路径全废（实测踩到）。
    && rm -rf node_modules/lucide-react node_modules/react node_modules/react-dom \
              node_modules/@types/react node_modules/@types/react-dom \
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
#   jq —— agent 解析 KB 结构化 JSON（middle_json/structured_content）高频使用
#   tini —— PID 1，转发 SIGTERM 让优雅关停跑完
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git openssh-client bzip2 procps wget jq tini \
    && rm -rf /var/lib/apt/lists/*

# KB skill 的 python 依赖（kb_shot.py 需要 pymupdf，kb_asset.py 需要 minio）：
# 构建期烘进 conda base，会话内 `python scripts/kb_shot.py` 开箱即用——
# 不靠启动期 pip（内网慢、失败只告警会让出图能力静默缺失）。
# 内网构建经 build arg 传镜像源：docker build --build-arg PIP_INDEX_URL=https://…
# 体积代价：pymupdf 装后约 40MB（镜像总量 +~2%）。装在 runtime 层（继承 base 的 conda），
# ARG 变更只重建这一层。
#
# 同层追加 wrenai[WREN 语义层，可选增强]：agent-native Text2SQL，网关启动时按
# WREN_DATASOURCES 为每个数据源自建项目 + `wren serve mcp` HTTP daemon（见
# src/core/wren.ts）。extras 默认取 mcp（FastMCP HTTP daemon）+ postgres + clickhouse
# （omp 目标库；duckdb 基础依赖自带，其余数据源按需在会话里补装）；
# WREN_EXTRAS build-arg 可按部署裁剪（如只查 PG：WREN_EXTRAS=mcp,postgres；
# 置空 = 只装 mcp 面所在的核心包，数据源驱动会话里再补）。
# py3.14 兼容性（本机实证，wrenai 0.18.0）：wheel 为 py3-none-any 纯 Python，
# conda base 的 python 3.14 直接可装，无需 uv/py3.12 独立 venv。
ARG PIP_INDEX_URL=""
ARG WREN_EXTRAS=mcp,postgres,clickhouse
RUN PIP_ARGS=""; \
    if [ -n "${PIP_INDEX_URL}" ]; then PIP_ARGS="-i ${PIP_INDEX_URL} --trusted-host $(echo ${PIP_INDEX_URL} | sed -E 's#https?://##; s#[:/].*##')"; fi; \
    /opt/conda/bin/pip install --no-cache-dir --quiet ${PIP_ARGS} pymupdf minio \
    && /opt/conda/bin/python -c "import fitz, minio; print('kb python deps ok:', fitz.__version__ if hasattr(fitz,'__version__') else 'pymupdf', minio.__version__)" \
    && WREN_PKG="wrenai" \
    && if [ -n "${WREN_EXTRAS}" ]; then WREN_PKG="wrenai[${WREN_EXTRAS}]"; fi \
    && /opt/conda/bin/pip install --no-cache-dir --quiet ${PIP_ARGS} "${WREN_PKG}" \
    && /opt/conda/bin/wren version

# Bun 二进制（builder 已装好，直接取；不含安装器缓存）
COPY --from=builder /opt/bun/bin/bun /usr/local/bin/bun

# Node 22 + npm（npm 侧 MCP server 需要）；属主给 1000，`npm i -g` 才写得进去
# （node 二进制本身在 builder 已 strip，这里用 --chown 而非事后 chown，避免 copy-up）
COPY --from=builder --chown=1000:1000 /opt/node /opt/node

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
      'export PATH="/opt/conda/bin:/usr/local/bin:/opt/node/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"' \
      'if [ -f /opt/conda/etc/profile.d/conda.sh ]; then' \
      '  . /opt/conda/etc/profile.d/conda.sh' \
      'fi' \
      '# 启动脚本固化的镜像源（uv/uvx 只认环境变量，不读 pip.conf）' \
      'if [ -f "$HOME/.config/omp/env.sh" ]; then' \
      '  . "$HOME/.config/omp/env.sh"' \
      'fi' \
      > /etc/profile.d/zz-omp-env.sh

ENV PATH="/opt/conda/bin:/usr/local/bin:/opt/node/bin:/home/omp/.local/bin:/home/omp/.bun/bin:${PATH}" \
    GATEWAY_PORT=8787 \
    GATEWAY_DATA_ROOT=/workspace/.omp-gateway \
    GATEWAY_EXPORT_DIR=/workspace/.omp-gateway/exports

# 作为 omp 运行时，agent 会在会话里用 bun 的全局安装 / bunx：把 BUN_INSTALL 从构建期的
# /opt/bun（root 只读）改到用户目录，并补上 bunx（官方安装器本来就有，我们只拷了 bun 二进制）
ENV BUN_INSTALL=/home/omp/.bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

WORKDIR /app/gateway

# 启动脚本：把 PIP_INDEX_URL / NPM_CONFIG_REGISTRY / CONDA_CHANNELS 等固化成
# $HOME 下的 pip.conf、.npmrc、.condarc（会话内 / MCP server 子进程一致生效）
COPY --chmod=755 docker/omp-entrypoint.sh /usr/local/bin/omp-entrypoint.sh

# 非 root 运行；/workspace 由 compose 以宿主目录挂载（属主可能不同，
# 因此容器内 uid 固定为 1000，与常见宿主用户一致）。
# 挂载点给 777：宿主机可直接读写会话产出，不依赖 uid 对齐（启动脚本还会再兜一次）。
#
# 知识库挂载点**预建在这里**（DESIGN §38.2；对应 compose 的 GATEWAY_DATA_ROOT_HOST 与
# GLOBAL_ROOT 两层挂载）：
# 若镜像里没有这两个目标目录，Docker 会为 bind mount 在 workspace 卷内自动创建父层
# /workspace/.omp-gateway 与 global/（属主 root:755），容器内 uid 1000 既写不了
# gateway.db（SQLITE_CANTOPEN）也 chmod 不动。预建 + 777 后，挂载只替换叶目录，
# 父层来自镜像层（可写）——知识库数据就能干净地挂在外部目录上。
RUN mkdir -p /workspace \
        /workspace/.omp-gateway/global/skills \
        /workspace/.omp-gateway/global/kb \
    && useradd --uid 1000 --create-home --shell /bin/bash omp \
    && mkdir -p /home/omp/.local/bin /home/omp/.bun/bin \
    && chown -R omp:omp /workspace /home/omp/.local /home/omp/.bun \
    && chmod 0777 /workspace /workspace/.omp-gateway /workspace/.omp-gateway/global \
                   /workspace/.omp-gateway/global/skills /workspace/.omp-gateway/global/kb
USER omp

# qmd 的 provider patch 源：先于全局安装 COPY 进构建上下文，下一层安装完立即就地改写
# 包内容（patch 与安装同"安装目录"，dist 属 omp 用户可写）
COPY docker/qmd-patch ./docker/qmd-patch

# qmd 检索引擎（KB 模块可选增强）：bun 全局安装（$BUN_INSTALL=/home/omp/.bun，bin 落
# /home/omp/.bun/bin，PATH 已含）+ provider patch（node 在镜像里有；apply.mjs --dir 指向
# bun 全局包目录，就地改写 dist——目录属 omp 用户，写权限满足）。
#
# 层序：本层排在**应用文件 COPY 之前**——src/scripts/package.json 是最高频的变更层，
# BuildKit 缓存链上排在其后的层每次提交都会失效重跑；qmd 安装层约 0.9GB（含下载），
# 必须让它只依赖 bun 二进制 + patch，不依赖源码。代价是 patch 变更时应用 COPY 层也要
# 重跑——但那些是本地拷贝（秒级），远比重拉 0.9GB 便宜。
#
# 体积说明（有意保留全量）：本层约 907MB，其中 662MB 是 @node-llama-cpp 多平台预编译
# （实测：linux-x64 28M / cuda 176M / cuda-ext 353M / vulkan 77M / arm64 18M / armv7l 12M），
# 另有 tree-sitter 语法 69M。多平台件在 linux-x64 + 远程 embedding（KB_QMD_EMBED_* 三件套）
# 下永不加载，但保留它们让「未配三件套」时本地 GGUF 兜底在任何宿主（含 GPU 机器）可用，
# 且 `--chunk-strategy auto` 的 tree-sitter 语法完整。**QMD_SLIM=1** 裁掉 cuda/vulkan/arm*
# 与 tree-sitter 语法（实测层 907→156MB、镜像 4.32→3.21GB）：代价是 GPU 宿主的本地 GGUF
# 加速与 auto 切块的语法感知；远程 embedding + BM25 主链路不受影响。rm 必须与安装同层
# （overlayfs 铁律见 DESIGN §35.5）；**bun 的 install/cache 是硬链接源（863MB，links=2），
# 只删 node_modules 侧不减层体积——必须一并清掉**（实测踩到，详见 DESIGN §41.3）。
#
# 构建期 npm 源：内网/受限网络下 registry.npmjs.org 直连会被掐（实测 ConnectionClosed），
# 传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com（compose 已透传，且会回退
# 到 NPM_CONFIG_REGISTRY）。
ARG NPM_REGISTRY=""
ARG QMD_SLIM=""
RUN bun install -g @tobilu/qmd ${NPM_REGISTRY:+--registry ${NPM_REGISTRY}} \
    && node docker/qmd-patch/apply.mjs --dir "${BUN_INSTALL}/install/global/node_modules/@tobilu/qmd" \
    # 冒烟：qmd 能启动 + patch 产物就位
    && qmd --version \
    && test -f "${BUN_INSTALL}/install/global/node_modules/@tobilu/qmd/dist/qmd-embed-api.js" \
    && if [ "${QMD_SLIM}" = "1" ]; then \
         rm -rf "${BUN_INSTALL}"/install/global/node_modules/@node-llama-cpp/linux-arm64 \
                "${BUN_INSTALL}"/install/global/node_modules/@node-llama-cpp/linux-armv7l \
                "${BUN_INSTALL}"/install/global/node_modules/@node-llama-cpp/linux-x64-cuda \
                "${BUN_INSTALL}"/install/global/node_modules/@node-llama-cpp/linux-x64-cuda-ext \
                "${BUN_INSTALL}"/install/global/node_modules/@node-llama-cpp/linux-x64-vulkan \
         # web-tree-sitter 等变体不匹配 tree-sitter-* 前缀，用 find 兜住
         && find "${BUN_INSTALL}"/install/global/node_modules -maxdepth 1 -type d -name '*tree-sitter*' -exec rm -rf {} + \
         # bun 全局安装把文件硬链接进 install/cache（实测 863MB，links=2 同 inode）：
         # 只删 node_modules 侧，数据仍被同层 cache 引用，层 diff 不减。必须一并清掉。
         && rm -rf "${BUN_INSTALL}/install/cache"; \
       fi

# 应用文件放最后：src/package 变更只重建这几层（本地 COPY，秒级，无下载）。
# 用 --chown 而非 chown -R：后者在 overlayfs 上会把整棵 node_modules 拷进新层（+500MB）
COPY --from=builder --chown=1000:1000 /app/gateway/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/gateway/src ./src
COPY --from=builder --chown=1000:1000 /app/gateway/scripts ./scripts
COPY --from=builder --chown=1000:1000 /app/gateway/package.json ./package.json
COPY --from=builder --chown=1000:1000 /app/gateway/bunfig.toml ./bunfig.toml

EXPOSE 8787

# 健康检查：/healthz 无凭据；/readyz 只探数据根可写（写删 .readyz-probe 探针文件，不触 DB）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/healthz" > /dev/null || exit 1

# tini 做 PID 1：转发 SIGTERM 给 bun，网关的优雅关停（dispose 全部 live 会话）才能跑完。
# 启动脚本先固化镜像源再 exec 网关（脚本走 exec，最后仍是单个进程，信号与退出码不受影响）
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/omp-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
