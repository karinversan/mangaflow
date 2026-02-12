from __future__ import annotations

from fastapi import HTTPException, status

ALLOWED_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
MAGIC_PREFIXES = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"RIFF",  # WEBP starts with RIFF....WEBP
)


def validate_upload(content_type: str | None, payload: bytes, max_upload_mb: int) -> None:
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported file type. Use PNG/JPEG/WEBP.",
        )
    if len(payload) < 64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image payload.")
    if len(payload) > max_upload_mb * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File too large. Max {max_upload_mb}MB.",
        )
    if not any(payload.startswith(prefix) for prefix in MAGIC_PREFIXES):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="File magic-bytes mismatch.")
    if payload.startswith(b"RIFF") and b"WEBP" not in payload[:16]:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Invalid WEBP payload.")
