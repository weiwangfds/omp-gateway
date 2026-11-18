#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kb_asset.py —— 知识库取图：把 docs/<doc>/images/ 下的 MinerU 裁剪图上传 MinIO，输出公网 URL。

用法（omp agent 在 skill 目录内用 bash 调用，DESIGN §38.7）：
    python kb_asset.py --doc <文档名> --image images/page_21_table_5.jpg [--image images/page_3_image_1.jpg ...]

依赖：纯标准库即可运行（本地模式）；仅当配置了 KB_MINIO_ENDPOINT 时才懒 import minio，
未装该包时自动回退本地模式，不影响出结果。

环境变量（容器 env 注入，DESIGN §38.8）：
    KB_MINIO_ENDPOINT          MinIO 写入端点（如 minio:9000，可带 http(s):// 前缀）；缺省 → 本地模式
    KB_MINIO_ENDPOINT_PUBLIC   输出 URL 基址（外网可达）；缺省 = ENDPOINT；已含 scheme 则直接作基
    KB_MINIO_ACCESS_KEY / KB_MINIO_SECRET_KEY  凭证
    KB_MINIO_BUCKET            桶名（默认 kb-assets；不存在自动建 + 公共读 policy）
    KB_MINIO_SECURE            "1" → https 连接 MinIO（默认 http）

输出：stdout 单行 JSON（ensure_ascii=False）：
    {"mode": "minio"|"local", "items": [{"image": ..., "url"|"path": ..., "error"?: ...}]}
单图缺失/上传失败只记在该 item 的 "error" 字段，整体不失败。
上传 key 与本地缓存文件名都用 sha256(文件字节) 前 16 位做内容寻址（同图去重）。
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
from pathlib import Path

# scripts/ 的上一级即 skill 根（脚本被复制进每个 kb-* skill 的 scripts/ 后位置关系不变）
SKILL_DIR = Path(__file__).resolve().parent.parent

# 与网关 KB_DOC_NAME_RE（DESIGN §38.2）一致：文档名作目录名，先校验防路径穿越
DOC_NAME_RE = r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}"

# put_object 的 content_type 按扩展名猜
CONTENT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
}

# 公共读桶策略：只放开下载（s3:GetObject），上传仍需凭证
BUCKET_POLICY = (
    '{"Version":"2012-10-17",'
    '"Statement":[{"Effect":"Allow","Principal":"*",'
    '"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::%s/*"]}]}'
)


def emit(obj) -> None:
    """统一输出：单行 JSON 到 stdout。"""
    print(json.dumps(obj, ensure_ascii=False))


def sha16(data: bytes) -> str:
    """内容寻址：sha256 前 16 位。"""
    return hashlib.sha256(data).hexdigest()[:16]


def content_type(suffix: str) -> str:
    return CONTENT_TYPES.get(suffix.lower(), "application/octet-stream")


def host_only(endpoint: str) -> str:
    """Minio SDK 的 endpoint 参数不带 scheme，剥掉前缀。"""
    for prefix in ("https://", "http://"):
        if endpoint.startswith(prefix):
            return endpoint[len(prefix):].rstrip("/")
    return endpoint.rstrip("/")


def public_url(public: str, bucket: str, key: str) -> str:
    """PUBLIC 已含 scheme 直接作基；否则按 http 前缀拼（要 https 就把端点写成 https:// 开头）。"""
    base = public.rstrip("/")
    if base.startswith("http://") or base.startswith("https://"):
        return f"{base}/{bucket}/{key}"
    return f"http://{base}/{bucket}/{key}"


def load_config():
    """读 KB_MINIO_* 环境变量；ENDPOINT 缺省 → None（本地模式）。"""
    endpoint = os.environ.get("KB_MINIO_ENDPOINT", "").strip()
    if not endpoint:
        return None
    return {
        "endpoint": endpoint,
        "public": os.environ.get("KB_MINIO_ENDPOINT_PUBLIC", "").strip() or endpoint,
        "access_key": os.environ.get("KB_MINIO_ACCESS_KEY", ""),
        "secret_key": os.environ.get("KB_MINIO_SECRET_KEY", ""),
        "bucket": os.environ.get("KB_MINIO_BUCKET", "").strip() or "kb-assets",
        "secure": os.environ.get("KB_MINIO_SECURE", "").strip() == "1",
    }


def build_client(cfg):
    """懒 import minio 并建客户端（缺包/连不上由调用方捕获后降级本地）。"""
    from minio import Minio  # 懒加载：未配 MinIO 时不要求安装

    return Minio(
        host_only(cfg["endpoint"]),
        access_key=cfg["access_key"],
        secret_key=cfg["secret_key"],
        secure=cfg["secure"],
    )


def ensure_bucket(client, bucket: str) -> None:
    """桶不存在则创建 + 公共读 policy（下载不需要凭证，上传仍需）。"""
    if client.bucket_exists(bucket):
        return
    client.make_bucket(bucket)
    client.set_bucket_policy(bucket, BUCKET_POLICY % bucket)


def local_copy(doc: str, name: str, data: bytes) -> Path:
    """本地模式/降级落点：assets/<doc>/<sha256 前 16>-<原名>（同图去重，已存在即复用）。"""
    dest_dir = SKILL_DIR / "assets" / doc
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{sha16(data)}-{name}"
    if not dest.exists():
        dest.write_bytes(data)
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="kb_asset.py",
        description="KB 取图：docs/<doc>/images/ 裁剪图 → MinIO 公网 URL（未配 MinIO 则落本地 assets/），stdout 输出 JSON。",
    )
    parser.add_argument("--doc", required=True, metavar="DOC",
                        help="文档名（对应 skill 的 docs/<DOC>/ 目录）")
    parser.add_argument("--image", action="append", required=True, metavar="PATH",
                        help="图片相对 docs/<DOC>/ 的路径（如 images/page_21_table_5.jpg），可重复传多张")
    args = parser.parse_args()

    if not re.fullmatch(DOC_NAME_RE, args.doc):
        emit({"error": f"invalid doc name: {args.doc!r}"})
        return 1

    doc_root = SKILL_DIR / "docs" / args.doc
    cfg = load_config()
    client = None
    init_error = None
    if cfg is not None:
        try:
            client = build_client(cfg)
            ensure_bucket(client, cfg["bucket"])
        except Exception as err:  # 缺 minio 包 / 端点或凭证问题 → 整体降级本地，不整体失败
            client = None
            init_error = f"{type(err).__name__}: {err}"

    items = []
    for rel in args.image:
        item = {"image": rel}
        src = doc_root / rel
        try:  # 防 --image 带 .. 越出文档目录
            inside = src.resolve().is_relative_to(doc_root.resolve())
        except OSError:
            inside = False
        if not inside or not src.is_file():
            item["error"] = f"not found: {src}"
            items.append(item)
            continue
        data = src.read_bytes()
        if client is not None:
            key = f"{sha16(data)}/{src.name}"  # 内容寻址：同图跨文档去重
            try:
                client.put_object(
                    cfg["bucket"], key, io.BytesIO(data), len(data),
                    content_type=content_type(src.suffix),
                )
                item["url"] = public_url(cfg["public"], cfg["bucket"], key)
                items.append(item)
                continue
            except Exception as err:  # 单条上传失败 → 本条降级本地，其余继续
                item["error"] = f"minio upload failed ({type(err).__name__}: {err})"
        item["path"] = str(local_copy(args.doc, src.name, data))
        if init_error is not None:
            item.setdefault("error", f"minio unavailable, fallback to local ({init_error})")
        items.append(item)

    emit({"mode": "minio" if client is not None else "local", "items": items})
    return 0


if __name__ == "__main__":
    sys.exit(main())
