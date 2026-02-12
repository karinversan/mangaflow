from __future__ import annotations

import json
from typing import Any

from botocore.client import BaseClient

from app.core.config import settings
from app.core.s3_client import get_s3_client


def build_input_key(owner_id: str, project_id: str, page_id: str, file_name: str) -> str:
    safe_name = file_name.replace("/", "_")
    return f"input/{owner_id}/{project_id}/{page_id}/{safe_name}"


def build_output_json_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/result.json"


def build_output_preview_key(owner_id: str, project_id: str, page_id: str, job_id: str) -> str:
    return f"output/{owner_id}/{project_id}/{page_id}/{job_id}/preview.png"


def upload_bytes(key: str, payload: bytes, content_type: str) -> None:
    client: BaseClient = get_s3_client()
    client.put_object(Bucket=settings.s3_bucket, Key=key, Body=payload, ContentType=content_type)


def upload_json(key: str, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    upload_bytes(key=key, payload=data, content_type="application/json")


def read_bytes(key: str) -> bytes:
    client: BaseClient = get_s3_client()
    response = client.get_object(Bucket=settings.s3_bucket, Key=key)
    return response["Body"].read()


def presign_get_url(key: str) -> str:
    client: BaseClient = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=settings.signed_url_expires_sec,
    )
