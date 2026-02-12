from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.models import User
from app.db.session import get_db

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    email: str | None = None


def _decode_token(token: str) -> dict:
    options = {"require": ["sub", "iat", "exp"]}
    decode_kwargs: dict = {
        "key": settings.jwt_secret,
        "algorithms": [settings.jwt_algorithm],
        "options": options,
        "leeway": settings.jwt_leeway_sec,
    }
    if settings.jwt_issuer:
        decode_kwargs["issuer"] = settings.jwt_issuer
    if settings.jwt_audience:
        decode_kwargs["audience"] = settings.jwt_audience
    try:
        return jwt.decode(token, **decode_kwargs)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid JWT token.") from exc


def create_access_token(sub: str, email: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, object] = {
        "sub": sub,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=settings.jwt_access_ttl_sec)).timestamp()),
    }
    if email:
        payload["email"] = email
    if settings.jwt_issuer:
        payload["iss"] = settings.jwt_issuer
    if settings.jwt_audience:
        payload["aud"] = settings.jwt_audience
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> AuthUser:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header.")
    payload = _decode_token(credentials.credentials)
    sub = str(payload.get("sub", "")).strip()
    if not sub:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="JWT token must contain subject.")
    email = payload.get("email")

    user = db.get(User, sub)
    if user is None:
        user = User(id=sub, email=email)
        db.add(user)
        db.commit()
    elif email and user.email != email:
        user.email = email
        db.add(user)
        db.commit()

    return AuthUser(user_id=sub, email=email)
