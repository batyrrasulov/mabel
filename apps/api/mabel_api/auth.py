from __future__ import annotations

from dataclasses import dataclass
import os

from fastapi import HTTPException, Request


@dataclass(frozen=True)
class MabelUser:
    email: str
    user_id: str
    name: str | None
    groups: tuple[str, ...]

    @property
    def is_mabel_approver(self) -> bool:
        return "mabel-approvers" in self.groups or self.is_mabel_admin

    @property
    def is_mabel_admin(self) -> bool:
        return "mabel-admins" in self.groups


def resolve_mabel_user(request: Request) -> MabelUser:
    mode = os.getenv("MABEL_AUTH_MODE", "development").strip().lower()
    if mode == "development":
        email = os.getenv("MABEL_DEV_USER_EMAIL", "developer@mabel.local").strip().lower()
        user_id = os.getenv("MABEL_DEV_USER_ID", email).strip()
        name = os.getenv("MABEL_DEV_USER_NAME", "Mabel Developer").strip()
        groups = ("mabel-admins", "mabel-approvers")
        return MabelUser(email=email, user_id=user_id, name=name, groups=groups)

    if mode != "trusted_headers":
        raise HTTPException(status_code=500, detail="Unsupported Mabel authentication mode")

    email = request.headers.get("x-user-email", "").strip().lower()
    user_id = request.headers.get("x-user-id", "").strip()
    if not email or not user_id:
        raise HTTPException(status_code=401, detail="Trusted identity headers are required")

    groups = tuple(
        group.strip()
        for group in request.headers.get("x-user-groups", "").split(",")
        if group.strip()
    )
    name = request.headers.get("x-user-name", "").strip() or None
    return MabelUser(email=email, user_id=user_id, name=name, groups=groups)
