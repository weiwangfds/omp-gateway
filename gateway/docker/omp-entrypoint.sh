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
  if ! chmod 0777 /workspace 2>/dev/null; then
    log "警告：/workspace 无法 chmod（属主不是 uid 1000）→ 请在宿主机 chmod 777 <WORKSPACE_ROOT>"
  fi
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

exec "$@"
