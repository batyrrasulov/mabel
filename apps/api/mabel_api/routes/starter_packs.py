from __future__ import annotations

from fastapi import APIRouter, Request

from ..auth import resolve_mabel_user
from ..db import get_store
from ..catalog import seed_builtin_catalog
from ..schemas import StartMyDayRequest, StarterPackMeeting
from ..telemetry import record_request_usage
from .workflows import _brief_for_meeting

router = APIRouter(prefix="/api/v1/starter-packs", tags=["starter-packs"])

ACCOUNT_MANAGER_PACK_ID = "starter-pack.account-manager"


def _ensure_account_manager_pack(settings) -> None:
    seed_builtin_catalog(get_store(settings), settings)


@router.post("/account-manager/start-my-day")
def account_manager_start_my_day(payload: StartMyDayRequest, request: Request) -> dict:
    settings = request.app.state.settings
    user = resolve_mabel_user(request)
    _ensure_account_manager_pack(settings)
    briefs = [_brief_for_meeting(meeting) for meeting in payload.meetings]
    output = f"Generated {len(briefs)} account-manager Start My Day brief{'s' if len(briefs) != 1 else ''}."
    record_request_usage(
        store=get_store(settings),
        settings=settings,
        user_email=user.email,
        surface="workflows",
        prompt=f"/start-my-day {payload.date}",
        output=output,
        metadata={"starter_pack_id": ACCOUNT_MANAGER_PACK_ID, "command": "/start-my-day"},
    )
    return {
        "starter_pack": {
            "id": ACCOUNT_MANAGER_PACK_ID,
            "name": "Account Manager Starter Pack",
            "role_key": "account-manager",
        },
        "command": "/start-my-day",
        "status": "completed",
        "date": payload.date,
        "draft_first": True,
        "briefs": briefs,
        "controlled_actions": [
            {"name": "Create Salesforce note draft", "scope": "create", "requires_approval": True},
            {"name": "Post Teams update", "scope": "create", "requires_approval": True},
            {"name": "Send customer email", "scope": "create", "requires_approval": True},
        ],
    }
