#!/bin/sh
# omp-gateway 容器启动脚本：把"包管理器镜像源"环境变量固化成配置。
#
# 为什么在启动时做：镜像里的 node_modules 与 conda base 是构建期烘好的，
# 这些源只影响**会话里**由 agent / MCP server 现装的包（pip、npm/npx、uvx、conda）。
#
# 落地点（都只作用于当前用户 /home/omp，权限 600 —— 源地址里可能带 token）：
#   $HOME/.config/pip/pip.conf   pip（含 venv 内的 pip；必须有 [global] 段头，否则 pip 拒载）
#   $HOME/.npmrc                 npm / npx
#   $HOME/.config/uv/uv.toml     uv / uvx（[[index]] 语法；uv 不读 pip.conf）
#   $HOME/.condarc               conda
#   $HOME/.config/omp/env.sh     同名环境变量，供登录 shell source（见 profile.d/zz-omp-env.sh）
#
# 全部可选：一个都不设就清掉 env.sh、不写其他配置，保留上游默认源。
set -eu

log() { printf '[omp-entrypoint] %s\n' "$*" >&2; }

HOME="${HOME:-/home/omp}"
export HOME

# ── 工作区根目录：777（宿主机可直接读写会话产出，不依赖 uid 对齐）──────────
# 挂载点属主通常是宿主用户而不是容器内 uid 1000，改不动就只告警：
# 宿主机侧执行 chmod 777 <WORKSPACE_ROOT> 即可（compose 的 volumes 不带权限）。
if [ -d /workspace ]; then
  # 能 chmod 就 chmod；chmod 失败但本来就可写（Docker Desktop 的挂载对 chmod 返回 EPERM）
  # 不算问题——只在真的不可写时才告警。
  chmod 0777 /workspace 2>/dev/null || true
  if [ ! -w /workspace ]; then
    log "警告：/workspace 不可写（属主不是 uid 1000 且不是 777）→ 请在宿主机执行 chmod 777 <WORKSPACE_ROOT>；否则网关创建数据根时会 EACCES"
  fi
fi

# ── 知识库/全局资源挂载点（compose 的 GATEWAY_DATA_ROOT_HOST 与 GLOBAL_ROOT 两层，DESIGN §38.2）──
# 这两个目录可能是 bind mount 源（Docker 自动创建时属主 = 宿主 root、模式 755），
# 容器内 uid 1000 建不了 skill 目录、写不了 <slug>.db 与 qmd 索引。
# 注意要**从数据根往下逐层**处理：为挂载子目录，Docker 会在 workspace 卷里自动创建
# /workspace/.omp-gateway 与 global/ 这两层（root:755）——只 chmod 叶目录的话，
# gateway.db 在数据根下创建时仍会 SQLITE_CANTOPEN。
# 能 chmod 就 chmod（bind mount 会同步改到宿主）；改不动且不可写只告警，不阻塞启动
# ——知识库接口会返回 500，其余能力不受影响。
if [ -d /workspace ]; then
  __data_root="${GATEWAY_DATA_ROOT:-/workspace/.omp-gateway}"
  for __dir in "$__data_root" "$__data_root/global" "$__data_root/global/skills" "$__data_root/global/kb"; do
    mkdir -p "$__dir" 2>/dev/null || true
    chmod 0777 "$__dir" 2>/dev/null || true
    if [ ! -w "$__dir" ]; then
      log "警告：$__dir 不可写（属主不是 uid 1000？）→ 请在宿主机执行 chmod 777 <KB 挂载源对应目录>；否则建库/入库会 EACCES"
    fi
  done
  unset __data_root __dir
fi

# 新建文件默认对宿主机可写（666/777）。要收紧就设 OMP_UMASK=0027。
umask "${OMP_UMASK:-0000}" 2>/dev/null || umask 0022

mkdir -p "$HOME/.config/omp"

# ── pip ────────────────────────────────────────────────────────────────────
if [ -n "${PIP_INDEX_URL:-}" ] || [ -n "${PIP_EXTRA_INDEX_URL:-}" ] || [ -n "${PIP_TRUSTED_HOST:-}" ] ||
  [ -n "${PIP_CERT:-}" ]; then
  mkdir -p "$HOME/.config/pip"
  {
    printf '[global]\n'
    if [ -n "${PIP_INDEX_URL:-}" ]; then
      printf 'index-url = %s\n' "$PIP_INDEX_URL"
    fi
    if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then
      printf 'extra-index-url = %s\n' "$PIP_EXTRA_INDEX_URL"
    fi
    if [ -n "${PIP_TRUSTED_HOST:-}" ]; then
      printf 'trusted-host = %s\n' "$PIP_TRUSTED_HOST"
    fi
    # 内网自签 CA：容器里挂一个 ca 文件，指向它即可
    if [ -n "${PIP_CERT:-}" ]; then
      printf 'cert = %s\n' "$PIP_CERT"
    fi
  } >"$HOME/.config/pip/pip.conf"
  chmod 600 "$HOME/.config/pip/pip.conf"
  log "pip 源：${PIP_INDEX_URL:-（仅设置了 extra-index/trusted-host）}"
fi

# ── uv / uvx：跟随 pip 源（python 侧 MCP server 常用 uvx 装包）──────────────
if [ -n "${PIP_INDEX_URL:-}" ] && [ -z "${UV_DEFAULT_INDEX:-}" ] && [ -z "${UV_INDEX_URL:-}" ]; then
  UV_DEFAULT_INDEX="$PIP_INDEX_URL"
  export UV_DEFAULT_INDEX
fi
if [ -n "${PIP_TRUSTED_HOST:-}" ] && [ -z "${UV_INSECURE_HOST:-}" ]; then
  UV_INSECURE_HOST="$PIP_TRUSTED_HOST"
  export UV_INSECURE_HOST
fi
uv_index="${UV_DEFAULT_INDEX:-${UV_INDEX_URL:-}}"
if [ -n "$uv_index" ] || [ -n "${UV_PYTHON_INSTALL_MIRROR:-}" ] || [ -n "${UV_PYTHON_DOWNLOADS:-}" ] ||
  [ -n "${UV_SYSTEM_CERTS:-${UV_NATIVE_TLS:-}}" ] || [ -n "${UV_INSECURE_HOST:-}" ]; then
  mkdir -p "$HOME/.config/uv"
  {
    if [ -n "$uv_index" ]; then
      printf '[[index]]\nurl = "%s"\ndefault = true\n' "$uv_index"
    fi
    # 内网：uv 的 Python 解释器默认从 GitHub 下载（python-build-standalone），
    # 连不上时要么指到内网镜像，要么用 conda 自带的 python（python-downloads = "never"）
    if [ -n "${UV_PYTHON_INSTALL_MIRROR:-}" ]; then
      printf 'python-install-mirror = "%s"\n' "$UV_PYTHON_INSTALL_MIRROR"
    fi
    if [ -n "${UV_PYTHON_DOWNLOADS:-}" ]; then
      printf 'python-downloads = "%s"\n' "$UV_PYTHON_DOWNLOADS"
    fi
    case "${UV_SYSTEM_CERTS:-${UV_NATIVE_TLS:-}}" in
      1 | true | TRUE | yes | YES) printf 'system-certs = true\n' ;;
    esac
    if [ -n "${UV_INSECURE_HOST:-}" ]; then
      printf 'allow-insecure-host = ['
      sep=''
      for h in $(printf '%s' "$UV_INSECURE_HOST" | tr ',' ' '); do
        printf '%s"%s"' "$sep" "$h"
        sep=', '
      done
      printf ']\n'
    fi
  } >"$HOME/.config/uv/uv.toml"
  chmod 600 "$HOME/.config/uv/uv.toml"
  log "uv 源：${uv_index:-（未设 index）}${UV_PYTHON_INSTALL_MIRROR:+ / python ← $UV_PYTHON_INSTALL_MIRROR}"
fi

# ── npm（npx 拉 npm 生态 MCP server 用）─────────────────────────────────────
npm_registry="${NPM_CONFIG_REGISTRY:-${NPM_REGISTRY:-}}"
if [ -n "$npm_registry" ]; then
  printf 'registry=%s\n' "$npm_registry" >"$HOME/.npmrc"
  chmod 600 "$HOME/.npmrc"
  NPM_CONFIG_REGISTRY="$npm_registry"
  export NPM_CONFIG_REGISTRY
  log "npm 源：$npm_registry"
fi

# ── conda ──────────────────────────────────────────────────────────────────
# CONDA_CHANNELS：额外的搜索源；CONDA_DEFAULT_CHANNELS：把 `defaults` 这个别名
# 也指到镜像上（否则 channels 里的 defaults 仍会去 repo.anaconda.com）。
if [ -n "${CONDA_CHANNELS:-}" ] || [ -n "${CONDA_DEFAULT_CHANNELS:-}" ]; then
  {
    if [ -n "${CONDA_CHANNELS:-}" ]; then
      printf 'channels:\n'
      # 逗号或空格分隔都接受
      for c in $(printf '%s' "$CONDA_CHANNELS" | tr ',' ' '); do
        printf '  - %s\n' "$c"
      done
    fi
    if [ -n "${CONDA_DEFAULT_CHANNELS:-}" ]; then
      printf 'default_channels:\n'
      for c in $(printf '%s' "$CONDA_DEFAULT_CHANNELS" | tr ',' ' '); do
        printf '  - %s\n' "$c"
      done
    fi
  } >"$HOME/.condarc"
  chmod 600 "$HOME/.condarc"
  log "conda 源：${CONDA_CHANNELS:-（仅覆盖 defaults）}${CONDA_DEFAULT_CHANNELS:+ / defaults → $CONDA_DEFAULT_CHANNELS}"
fi

# ── git 本地面（DESIGN §41.8）：omp 的 checkpoint/rewind 是会话树机制，不依赖 git；
# git 只服务会话内的本地版本管理（init/add/保存点/历史），无远端要求。
# 两个开箱即用缺口：
#   1) 默认身份——镜像不带任何 git 配置，无身份时本地保存点会报 "Please tell me who
#      you are"。部署侧用 GIT_USER_NAME / GIT_USER_EMAIL 覆盖，缺省给会话本地身份。
#   2) safe.directory——/workspace 是 777 bind mount，宿主 uid ≠ 容器 1000 时 git 会以
#      dubious ownership 拒绝操作；放行（GIT_SAFE_DIRECTORY=0 可关）。容器内无提权面，
#      该文件属主即当前用户，放行不扩大攻击面。
git_name="${GIT_USER_NAME:-omp-session}"
git_email="${GIT_USER_EMAIL:-omp-session@localhost}"
{
  printf '[user]\n\tname = %s\n\temail = %s\n' "$git_name" "$git_email"
  printf '[init]\n\tdefaultBranch = main\n'
  if [ "${GIT_SAFE_DIRECTORY:-1}" != "0" ]; then
    printf '[safe]\n\tdirectory = *\n'
  fi
} >"$HOME/.gitconfig"
chmod 600 "$HOME/.gitconfig"
log "git 本地身份：${git_name} <${git_email}>；safe.directory 通配 $([ "${GIT_SAFE_DIRECTORY:-1}" != "0" ] && echo 开 || echo 关)"

# ── 环境变量落地：登录 shell 里与容器 env 对齐（uv/uvx 只认环境变量）────────
emit() {
  if [ -n "${2:-}" ]; then
    # 单引号包裹并转义内部单引号
    printf "export %s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"
  fi
}
if [ -n "${PIP_INDEX_URL:-}${PIP_EXTRA_INDEX_URL:-}${PIP_TRUSTED_HOST:-}${UV_DEFAULT_INDEX:-}${UV_INSECURE_HOST:-}${NPM_CONFIG_REGISTRY:-}" ]; then
  {
    emit PIP_INDEX_URL "${PIP_INDEX_URL:-}"
    emit PIP_EXTRA_INDEX_URL "${PIP_EXTRA_INDEX_URL:-}"
    emit PIP_TRUSTED_HOST "${PIP_TRUSTED_HOST:-}"
    emit UV_DEFAULT_INDEX "${UV_DEFAULT_INDEX:-}"
    emit UV_INSECURE_HOST "${UV_INSECURE_HOST:-}"
    emit NPM_CONFIG_REGISTRY "${NPM_CONFIG_REGISTRY:-}"
  } >"$HOME/.config/omp/env.sh"
  chmod 600 "$HOME/.config/omp/env.sh"
else
  # 没配任何源：清掉上次启动可能残留的
  rm -f "$HOME/.config/omp/env.sh"
fi

# ── KB skill python 依赖：pymupdf + minio（KB_SKILL_PY_DEPS=1 时兜底安装）─────
# 当前镜像已在构建期烘入 pymupdf + minio（Dockerfile PIP_INDEX_URL build-arg 段），
# 这里通常直接命中「已就绪」分支。保留本段作为旧镜像/精简构建的运行时兜底：
# kb_shot.py / kb_asset.py（全局 skill 的 scripts/）运行期才需要；网关进程自身
# 零 PDF/minio 依赖（DESIGN §38.7）。pip 源已在前面段落固化成 pip.conf，内网可用。
# 失败只告警不阻塞启动——截图/取图不可用时查询照常（agent 还能 grep 语料本体）。
if [ "${KB_SKILL_PY_DEPS:-}" = "1" ]; then
  kb_py="$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)"
  if [ -z "$kb_py" ]; then
    log "警告：容器内找不到 python/python3 → KB 截图/取图脚本不可用，查询不受影响"
  elif "$kb_py" -c "import fitz, minio" >/dev/null 2>&1; then
    log "KB skill python 依赖已就绪（pymupdf + minio）"
  elif ! "$kb_py" -m pip install --quiet --no-input pymupdf minio; then
    log "警告：pip 安装 pymupdf/minio 失败 → 截图/取图脚本不可用，查询不受影响"
  else
    log "KB skill python 依赖已安装（pymupdf + minio）"
  fi
fi

# ── KB MinIO 配置完整性：只告警不阻塞（脚本自身会回退本地 assets/ 模式）──────
# 不做 TCP 探活（sh 没有 /dev/tcp，不为此引入依赖）；连不连得上由脚本首次上传时体现。
kb_endpoint="${KB_MINIO_ENDPOINT:-}"
kb_access_key="${KB_MINIO_ACCESS_KEY:-}"
kb_secret_key="${KB_MINIO_SECRET_KEY:-}"
if [ -n "$kb_endpoint" ] && [ -z "$kb_access_key" ]; then
  log "警告：KB_MINIO_ENDPOINT 已设但 KB_MINIO_ACCESS_KEY 未配 → 取图/截图上传将失败并回退本地 assets/"
elif [ -n "$kb_endpoint" ] && [ -z "$kb_secret_key" ]; then
  log "警告：KB_MINIO_ENDPOINT 已设但 KB_MINIO_SECRET_KEY 未配 → 取图/截图上传将失败并回退本地 assets/"
elif [ -n "$kb_endpoint" ] && [ -z "${KB_MINIO_ENDPOINT_PUBLIC:-}" ]; then
  log "提示：KB_MINIO_ENDPOINT_PUBLIC 未配置 → 输出 URL 按内网端点拼接（报告中外网不可达）；外网交付请在 compose 配置外网基址"
elif [ -z "$kb_endpoint" ] && [ -n "$kb_access_key" ]; then
  log "警告：KB_MINIO_ACCESS_KEY/SECRET_KEY 已设但 KB_MINIO_ENDPOINT 缺失 → 截图/取图走本地 assets/（凭证被忽略）"
elif [ -z "$kb_endpoint" ]; then
  log "MinIO 未配置：截图/取图输出落本地 assets/（kb_shot/kb_asset 本地模式）"
fi

# ── qmd MCP daemon（KB 检索引擎的可选语义面，KB_QMD_MCP=1 才起）───────────────
# daemon 是同容器内的环回服务（127.0.0.1:8181/mcp），网关启动时经 ensureQmdMcpRegistered
# 把该地址写进 global/mcp.json，会话才有 qmd 检索工具。QMD_CONFIG_DIR / XDG_CACHE_HOME
# 已由 compose env 传给本进程，daemon 直接继承——索引/模型缓存/PID 文件都随挂载卷走。
# daemon 自身幂等（已有存活实例时退出非零），失败只告警：语义检索不可用，
# BM25 检索（qmd update 后即刻可用）与 grep 检索路不受影响。
if [ "${KB_QMD_MCP:-}" = "1" ]; then
  # qmd 数据目录可写性自检：QMD_CONFIG_DIR / XDG_CACHE_HOME 由 compose 注入（正常是
  # /workspace 下的路径）。若被误配成宿主路径（如 Git Bash 的 MSYS 路径转换把
  # /workspace/... 变成 C:/Program Files/Git/workspace/...）→ daemon 会在 mkdir 时
  # EACCES 退出，且错误被重定向吞掉，表现为「daemon 起不来」。这里先探测，坏值回退
  # 到 qmd 默认目录（$HOME 下）并告警——索引不随卷走，但检索能力可用。
  for __kb_var in QMD_CONFIG_DIR XDG_CACHE_HOME; do
    eval "__kb_val=\${$__kb_var:-}"
    # mkdir -p 对已存在目录恒成功，测不出「存在但不可写」——补 [ ! -w ] 才能覆盖 EACCES 的另一半场景
    if [ -n "$__kb_val" ] && { ! mkdir -p "$__kb_val" 2>/dev/null || [ ! -w "$__kb_val" ]; }; then
      log "警告：$__kb_var=$__kb_val 不可创建/不可写 → 回退 qmd 默认目录（索引不随 /workspace 卷迁移）"
      eval "unset $__kb_var"
      unset __kb_val
    fi
  done
  unset __kb_var __kb_val
  if command -v qmd >/dev/null 2>&1; then
    # 三件套门禁（实测必踩）：daemon 若无 KB_QMD_EMBED_* 会走 qmd 原生本地 GGUF，
    # 容器内没有模型/原生二进制时**查询会静默挂死**（而非报错）。宁可不起 daemon：
    # 会话侧退化为 grep/BM25 检索路，也不会挂住 agent 的工具调用。
    if [ -z "${KB_QMD_EMBED_BASE_URL:-}" ] || [ -z "${KB_QMD_EMBED_API_KEY:-}" ] || [ -z "${KB_QMD_EMBED_MODEL:-}" ]; then
      log "警告：KB_QMD_MCP=1 但 KB_QMD_EMBED_BASE_URL/API_KEY/MODEL 未配齐 → 不启动 qmd daemon（否则语义检索会挂死）；grep 兜底可用"
    # --host 127.0.0.1：缺省绑定可能落在 [::1]（IPv6），而 mcp.json 注册的是 IPv4 环回地址，
    # 会话侧会连不上（Windows 实测踩到）；显式钉死 IPv4 与注册地址一致。
    elif qmd --index "${KB_QMD_INDEX:-kb}" mcp --http --daemon --host 127.0.0.1 >/dev/null 2>&1; then
      log "qmd MCP daemon 已启动（127.0.0.1:8181/mcp，index=${KB_QMD_INDEX:-kb}）"
    else
      log "警告：qmd MCP daemon 启动失败（可能已在运行或端口被占）→ 会话无 qmd 语义检索工具，grep 不受影响"
    fi
  else
    log "警告：KB_QMD_MCP=1 但容器内找不到 qmd → 跳过 daemon 启动（BM25/语义检索不可用，grep 不受影响）"
  fi
fi

exec "$@"
