"""【金控】筆電申請單 form skill."""

from __future__ import annotations

from pathlib import Path

from playwright.async_api import Page
from pydantic import BaseModel

from app.forms.base import FormSkill
from app.forms.laptop.fill import fill_laptop
from app.forms.laptop.schema import LaptopPayload
from app.profile import UserProfile


_INSTRUCTIONS = (Path(__file__).parent / "instructions.md").read_text(encoding="utf-8")


async def _fill(page: Page, payload: BaseModel) -> None:
    assert isinstance(payload, LaptopPayload)
    await fill_laptop(page, payload)


def _profile_defaults(profile: UserProfile, raw: dict) -> dict:
    """Personal-info fields auto-filled from logged-in user.

    Skipped entirely when applicantIsUser="no" — in that case the form is
    being filled for someone else and the AI must collect their data.
    """
    if raw.get("applicantIsUser") == "no":
        return {}
    return {
        "name": profile.name,
        "employeeId": profile.employee_id,
        "contact": profile.contact,
        "email": profile.email,
        "location": profile.department_location,
    }


skill = FormSkill(
    id="laptop",
    label="【金控】筆電申請單",
    description=(
        "申請公務筆電。需填寫需求類型、使用者基本資料、申請方案、特殊權限、"
        "風險評估、持有設備清單與聲明書同意。"
    ),
    url=(
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=685219a0fbb2b7651dbc0ffc&EMP_COMP_ID=C0"
    ),
    payload_model=LaptopPayload,
    instructions=_INSTRUCTIONS,
    fill=_fill,
    profile_defaults=_profile_defaults,
)
