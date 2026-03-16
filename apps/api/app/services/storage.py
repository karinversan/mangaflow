from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import quote

from app.core.config import settings

logger = logging.getLogger(__name__)

_USE_LOCAL = settings.storage_backend == "local"


# ── key builders ──────────────────────────────────────────────────────────

def build_input_key(owner_id: str, project_id: str, page_id: str, file_name: str) -> str:
    safe_name = file_name.replace("/", "_")
    return f"input/{owner_id}/{project_id}/{page_id}/{safe_name}"


def build_output_json_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/result.json"


def build_output_preview_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/preview.png"


def build_output_mask_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/mask.png"


def build_output_inpainted_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/inpainted.png"


# ── local filesystem helpers ──────────────────────────────────────────────

def _local_root() -> Path:
    return Path(settings.local_storage_path)


def _local_path(key: str) -> Path:
    return _local_root() / key


# ── public API ────────────────────────────────────────────────────────────

def upload_bytes(key: str, payload: bytes, content_type: str) -> None:
    if _USE_LOCAL:
        p = _local_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(payload)
        return
    from botocore.client import BaseClient
    from app.core.s3_client import get_s3_client
    client: BaseClient = get_s3_client()
    client.put_object(Bucket=settings.s3_bucket, Key=key, Body=payload, ContentType=content_type)


def upload_json(key: str, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    upload_bytes(key=key, payload=data, content_type="application/json")


def read_bytes(key: str) -> bytes:
    if _USE_LOCAL:
        return _local_path(key).read_bytes()
    from botocore.client import BaseClient
    from app.core.s3_client import get_s3_client
    client: BaseClient = get_s3_client()
    response = client.get_object(Bucket=settings.s3_bucket, Key=key)
    return response["Body"].read()


def presign_get_url(key: str) -> str:
    if _USE_LOCAL:
        return f"/api/v1/storage/{quote(key, safe='')}"
    from botocore.client import BaseClient
    from app.core.s3_client import get_s3_client
    client: BaseClient = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=settings.signed_url_expires_sec,
    )


def presign_put_url(key: str, content_type: str) -> str:
    if _USE_LOCAL:
        return f"/api/v1/storage/{quote(key, safe='')}"
    from botocore.client import BaseClient
    from app.core.s3_client import get_s3_client
    client: BaseClient = get_s3_client()
    return client.generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.s3_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=settings.signed_url_expires_sec,
    )


def key_exists(key: str) -> bool:
    if _USE_LOCAL:
        return _local_path(key).exists()
    from botocore.client import BaseClient
    from app.core.s3_client import get_s3_client
    client: BaseClient = get_s3_client()
    try:
        client.head_object(Bucket=settings.s3_bucket, Key=key)
        return True
    except Exception:
        return False
