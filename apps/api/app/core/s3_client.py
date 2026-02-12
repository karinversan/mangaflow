from __future__ import annotations

from functools import lru_cache

import boto3
from botocore.client import BaseClient
from botocore.config import Config

from app.core.config import settings


@lru_cache(maxsize=1)
def get_s3_client() -> BaseClient:
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4"),
    )


def ensure_bucket_exists() -> None:
    s3 = get_s3_client()
    bucket = settings.s3_bucket
    existing = [item["Name"] for item in s3.list_buckets().get("Buckets", [])]
    if bucket not in existing:
        s3.create_bucket(Bucket=bucket)


def check_s3_ready() -> bool:
    try:
        s3 = get_s3_client()
        s3.head_bucket(Bucket=settings.s3_bucket)
        return True
    except Exception:
        return False
