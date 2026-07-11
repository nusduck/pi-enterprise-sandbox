"""Auth foundation: register / login / me (optional when SANDBOX_AUTH_ENABLED)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sandbox.auth import create_token, hash_password, verify_password, verify_token
from sandbox.config import settings
from sandbox.repositories import UserRepository
from sandbox.security.ownership import BOOTSTRAP_ORG_ID

router = APIRouter(prefix="/auth", tags=["auth"])
users = UserRepository()


class RegisterBody(BaseModel):
    username: str = Field(..., min_length=2, max_length=64)
    password: str = Field(..., min_length=6, max_length=128)
    email: str | None = None
    display_name: str | None = None
    # Phase 1: clients cannot self-select org; always bootstrap (field ignored if sent).
    organization_id: str | None = None


class LoginBody(BaseModel):
    username: str
    password: str


def _public_user(u: dict) -> dict:
    return {
        "id": u["id"],
        "username": u["username"],
        "email": u.get("email"),
        "display_name": u.get("display_name"),
        "role": u.get("role", "user"),
        "organization_id": u.get("organization_id") or BOOTSTRAP_ORG_ID,
    }


@router.post("/register")
def register(body: RegisterBody):
    if users.get_by_username(body.username):
        raise HTTPException(status_code=409, detail="Username already exists")
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    entry = users.create(
        user_id=user_id,
        username=body.username,
        password_hash=hash_password(body.password),
        email=body.email,
        display_name=body.display_name,
        # Ignore client-supplied organization_id (no self-join into arbitrary orgs).
        organization_id=BOOTSTRAP_ORG_ID,
    )
    token = create_token(
        user_id=entry["id"],
        username=entry["username"],
        role=entry.get("role", "user"),
        organization_id=entry.get("organization_id") or BOOTSTRAP_ORG_ID,
        ttl_seconds=settings.jwt_ttl_seconds,
    )
    return {"token": token, "user": _public_user(entry)}


@router.post("/login")
def login(body: LoginBody):
    entry = users.get_by_username(body.username)
    if not entry or not entry.get("is_active"):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not verify_password(body.password, entry["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    users.touch_login(entry["id"])
    token = create_token(
        user_id=entry["id"],
        username=entry["username"],
        role=entry.get("role", "user"),
        organization_id=entry.get("organization_id") or BOOTSTRAP_ORG_ID,
        ttl_seconds=settings.jwt_ttl_seconds,
    )
    return {"token": token, "user": _public_user(entry)}


@router.get("/me")
def me(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = verify_token(auth[7:].strip())
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    entry = users.get_by_id(payload["sub"])
    if not entry:
        raise HTTPException(status_code=401, detail="User not found")
    return _public_user(entry)
