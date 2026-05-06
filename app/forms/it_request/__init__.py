"""資訊作業申請 form skill."""

from __future__ import annotations

from pathlib import Path

from playwright.async_api import Page
from pydantic import BaseModel

from app.forms.base import FormSkill
from app.forms.it_request.fill import fill_it_request
from app.forms.it_request.schema import ItRequestPayload
from app.profile import UserProfile


_INSTRUCTIONS = (Path(__file__).parent / "instructions.md").read_text(encoding="utf-8")


async def _fill(page: Page, payload: BaseModel) -> None:
    assert isinstance(payload, ItRequestPayload)
    await fill_it_request(page, payload)


def _profile_defaults(profile: UserProfile, raw: dict) -> dict:
    return {"applicant": profile.name}


skill = FormSkill(
    id="it_request",
    label="資訊作業申請",
    description="資訊作業申請單，用於申請系統作業。需填寫申請者、原因、需求、時段、作業人員。",
    url=(
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=6886d10efbb2b7284c267690&EMP_COMP_ID=C0"
    ),
    payload_model=ItRequestPayload,
    instructions=_INSTRUCTIONS,
    fill=_fill,
    profile_defaults=_profile_defaults,
)
