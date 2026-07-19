"""Auth foundation: register / login / me (BFF proxies these to Sandbox)."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sandbox.auth import create_token, hash_password, verify_password, verify_token
from sandbox.config import is_mysql_database_url, settings
from sandbox.security.ownership import BOOTSTRAP_ORG_ID

router = APIRouter(prefix="/auth", tags=["auth"])

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_./@+-]{2,64}$")


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


def _users_repo():
    """Lazy MySQL-backed credential store (Agent Knex owns schema)."""
    url = (settings.database_url or "").strip()
    if not url or not is_mysql_database_url(url):
        raise HTTPException(
            status_code=503,
            detail="Auth store unavailable (MySQL not configured)",
        )
    try:
        from sandbox.app.persistence.db import create_mysql_database
        from sandbox.app.persistence.repositories.auth_credential_repository import (
            AuthCredentialRepository,
        )

        db = create_mysql_database(
            url,
            connect_timeout=int(settings.mysql_connect_timeout_seconds),
            read_timeout=int(settings.mysql_read_timeout_seconds),
            write_timeout=int(settings.mysql_write_timeout_seconds),
            max_connections=int(settings.mysql_max_connections),
        )
        return AuthCredentialRepository(db)
    except Exception as exc:  # noqa: BLE001 — map store failures to 503
        raise HTTPException(
            status_code=503,
            detail=f"Auth store unavailable: {type(exc).__name__}",
        ) from exc


def _normalize_username(raw: str) -> str:
    username = (raw or "").strip()
    if not _USERNAME_RE.match(username):
        raise HTTPException(
            status_code=422,
            detail="Username must be 2–64 chars: letters, digits, _ . / @ + -",
        )
    return username


@router.post("/register")
def register(body: RegisterBody):
    # Production / hardened deployments disable public self-registration.
    if not settings.auth_allow_public_register:
        raise HTTPException(
            status_code=403,
            detail="Public registration is disabled; contact an administrator",
        )
    username = _normalize_username(body.username)
    users = _users_repo()
    if users.get_by_username(username):
        raise HTTPException(status_code=409, detail="Username already exists")
    # External subject for Agent mapping (not a platform ULID).
    external_user_id = f"user_{uuid.uuid4().hex[:16]}"
    try:
        entry = users.create(
            username=username,
            password_hash=hash_password(body.password),
            external_user_id=external_user_id,
            email=body.email,
            display_name=body.display_name,
            # Ignore client-supplied organization_id (no self-join into arbitrary orgs).
            external_org_id=BOOTSTRAP_ORG_ID,
        )
    except Exception as exc:  # noqa: BLE001
        # Unique race or missing table.
        msg = str(exc).lower()
        if "duplicate" in msg or "unique" in msg:
            raise HTTPException(status_code=409, detail="Username already exists") from exc
        if "auth_credentials" in msg and ("doesn't exist" in msg or "not found" in msg):
            raise HTTPException(
                status_code=503,
                detail="Auth schema missing; run Agent migrations (auth_credentials)",
            ) from exc
        raise HTTPException(status_code=500, detail="Registration failed") from exc

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
    username = (body.username or "").strip()
    if not username:
        raise HTTPException(status_code=422, detail="Username is required")
    users = _users_repo()
    try:
        entry = users.get_by_username(username)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if "auth_credentials" in msg and ("doesn't exist" in msg or "not found" in msg):
            raise HTTPException(
                status_code=503,
                detail="Auth schema missing; run Agent migrations (auth_credentials)",
            ) from exc
        raise HTTPException(status_code=503, detail="Auth store unavailable") from exc
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
    users = _users_repo()
    try:
        entry = users.get_by_external_user_id(str(payload["sub"]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="Auth store unavailable") from exc
    if not entry:
        raise HTTPException(status_code=401, detail="User not found")
    return _public_user(entry)
