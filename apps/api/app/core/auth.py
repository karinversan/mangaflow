from __future__ import annotations

from dataclasses import dataclass

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
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid JWT token.") from exc


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
