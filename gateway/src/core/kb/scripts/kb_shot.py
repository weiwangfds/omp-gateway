#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kb_shot.py —— 知识库截图：从 docs/<doc>/source.pdf 按 middle_json 的 bbox 高保真重渲染 PNG。

用法（omp agent 在 skill 目录内用 bash 调用，DESIGN §38.7）：
    python kb_shot.py --doc <文档名> --page 21 [--table 5 | --image 3 | --bbox x0,y0,x1,y1]

    --page N    1 基页码（MinerU 的 page_N 即 PDF 第 N 页）
    --table M   取该页第 M 个 table 块（middle_json 的 para_blocks 出现顺序，1 基）
    --image M   取该页第 M 个 image 块（同上）
    --bbox      直接给 PDF 点坐标 x0,y0,x1,y1（middle_json 查不到时的兜底）
    三者都不给 = 整页截图。

依赖：pymupdf（import fitz 在函数内懒加载，缺包报清晰错误）；
MinIO 可选（KB_MINIO_* 配置齐全才上传，key = <doc>/<sha256 前 16>.png；失败/未配置落本地 assets/）。

输出：stdout 单行 JSON（ensure_ascii=False）：
    {"mode": "minio"|"local", "page": N, "image": "<png 文件名>", "url"|"path": ...}
失败：{"error": "..."} 且 exit 1。
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


def parse_bbox(text: str):
    """--bbox "x0,y0,x1,y1" → [float]；非法即抛 ValueError（main 统一转 error JSON）。"""
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise ValueError(f"--bbox expects x0,y0,x1,y1 (4 numbers), got: {text!r}")
    try:
        x0, y0, x1, y1 = (float(p) for p in parts)
    except ValueError as err:
        raise ValueError(f"--bbox expects numeric x0,y0,x1,y1, got: {text!r}") from err
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"--bbox needs x1>x0 and y1>y0, got: {text!r}")
    return [x0, y0, x1, y1]


def bbox_from_middle(middle_path: Path, page_no: int, kind: str, ordinal: int):
    """middle_json.pdf_info[page-1].para_blocks 里按出现顺序找第 ordinal 个 kind 块的 bbox。"""
    try:
        middle = json.loads(middle_path.read_text(encoding="utf-8"))
    except FileNotFoundError as err:
        raise LookupError(
            "middle_json.json missing — pass --bbox x0,y0,x1,y1 directly"
        ) from err
    except (json.JSONDecodeError, UnicodeDecodeError) as err:
        raise LookupError(
            f"middle_json.json parse failed ({err}) — pass --bbox x0,y0,x1,y1 directly"
        ) from err
    pdf_info = middle.get("pdf_info") or []
    if not 1 <= page_no <= len(pdf_info):
        raise LookupError(
            f"page {page_no} not in middle_json pdf_info ({len(pdf_info)} pages)"
            " — pass --bbox x0,y0,x1,y1 directly"
        )
    matched = 0
    for block in pdf_info[page_no - 1].get("para_blocks") or []:
        if kind not in str(block.get("type", "")):
            continue
        matched += 1
        if matched == ordinal:
            bbox = block.get("bbox")
            if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
                raise LookupError(
                    f"#{ordinal} {kind} block on page {page_no} has invalid bbox: {bbox!r}"
                    " — pass --bbox x0,y0,x1,y1 directly"
                )
            return [float(v) for v in bbox]
    raise LookupError(
        f"no #{ordinal} {kind} block on page {page_no} (found {matched})"
        " — pass --bbox x0,y0,x1,y1 directly"
    )


def render(pdf_path: Path, page_no: int, bbox):
    """渲染指定区域（bbox=None 整页）→ PNG 字节；Matrix(2,2) 放大 2x 保证清晰度。"""
    try:
        import fitz  # 懒加载：只在真的要截图时才要求 pymupdf
    except ImportError as err:
        raise RuntimeError("pymupdf not installed — run: pip install pymupdf") from err
    with fitz.open(pdf_path) as pdf:
        if not 1 <= page_no <= pdf.page_count:
            raise LookupError(f"page {page_no} out of range (pdf has {pdf.page_count} pages)")
        page = pdf[page_no - 1]  # fitz 页码 0 基；MinerU page_N 为 1 基
        clip = fitz.Rect(*bbox) if bbox is not None else None
        pix = page.get_pixmap(clip=clip, matrix=fitz.Matrix(2, 2))
        return pix.tobytes("png")


def shot_name(args) -> str:
    """本地落盘文件名：shot-p<N>[t<M>|i<M>|<bbox>].png（同参数重跑复用同一文件名）。"""
    if args.table is not None:
        suffix = f"t{args.table}"
    elif args.image is not None:
        suffix = f"i{args.image}"
    elif args.bbox is not None:
        # bbox 模式把坐标编进文件名：同参数幂等复用，不同 bbox 互不覆盖
        suffix = "-" + re.sub(r"[^0-9A-Za-z.]+", "_", args.bbox.strip())
    else:
        suffix = ""
    return f"shot-p{args.page}{suffix}.png"


def local_save(doc: str, name: str, data: bytes) -> Path:
    """先落 assets/<doc>/：上传失败的回退输出，也是幂等复用的缓存。"""
    dest_dir = SKILL_DIR / "assets" / doc
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    if not dest.exists():
        dest.write_bytes(data)
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="kb_shot.py",
        description="KB 截图：source.pdf 按 middle_json bbox 高保真重渲染 PNG（2x），上传 MinIO 或落本地 assets/。",
    )
    parser.add_argument("--doc", required=True, metavar="DOC",
                        help="文档名（对应 skill 的 docs/<DOC>/ 目录，须有 source.pdf）")
    parser.add_argument("--page", required=True, type=int, metavar="N",
                        help="1 基页码（MinerU 的 page_N 即 PDF 第 N 页）")
    region = parser.add_mutually_exclusive_group()
    region.add_argument("--table", type=int, metavar="M",
                        help="该页第 M 个 table 块（middle_json para_blocks 顺序，1 基）")
    region.add_argument("--image", type=int, metavar="M",
                        help="该页第 M 个 image 块（middle_json para_blocks 顺序，1 基）")
    region.add_argument("--bbox", metavar="X0,Y0,X1,Y1",
                        help="直接给 PDF 点坐标区域（middle_json 查不到时兜底）")
    args = parser.parse_args()

    if not re.fullmatch(DOC_NAME_RE, args.doc):
        emit({"error": f"invalid doc name: {args.doc!r}"})
        return 1

    doc_dir = SKILL_DIR / "docs" / args.doc
    pdf_path = doc_dir / "source.pdf"
    if not pdf_path.is_file():
        emit({"error": (
            f"source.pdf missing for doc {args.doc} — screenshot needs the original PDF "
            "(POST /admin/kb/:slug/pdf)"
        )})
        return 1

    try:
        if args.bbox is not None:
            bbox = parse_bbox(args.bbox)
        elif args.table is not None:
            bbox = bbox_from_middle(doc_dir / "middle_json.json", args.page, "table", args.table)
        elif args.image is not None:
            bbox = bbox_from_middle(doc_dir / "middle_json.json", args.page, "image", args.image)
        else:
            bbox = None  # 三者都缺 → 整页截图
        png = render(pdf_path, args.page, bbox)
    except Exception as err:  # 脚本契约：失败一律 {"error"} + 非零退出（含缺 pymupdf）
        emit({"error": str(err)})
        return 1

    name = shot_name(args)
    dest = local_save(args.doc, name, png)

    result = {"mode": "local", "page": args.page, "image": name, "path": str(dest)}
    cfg = load_config()
    if cfg is not None:
        client = None
        try:
            client = build_client(cfg)
            ensure_bucket(client, cfg["bucket"])
        except Exception as err:  # 缺 minio 包 / 端点或凭证问题 → 保留本地 path
            result["error"] = f"minio unavailable, keep local path ({type(err).__name__}: {err})"
        if client is not None:
            key = f"{args.doc}/{sha16(png)}.png"  # 内容寻址：同图重截去重
            try:
                client.put_object(cfg["bucket"], key, io.BytesIO(png), len(png),
                                  content_type="image/png")
                result = {"mode": "minio", "page": args.page, "image": name,
                          "url": public_url(cfg["public"], cfg["bucket"], key)}
            except Exception as err:  # 上传失败 → 降级本地输出 path
                result["error"] = f"minio upload failed, keep local path ({type(err).__name__}: {err})"
    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
