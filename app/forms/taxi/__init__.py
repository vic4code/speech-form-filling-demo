"""Taxi expense reimbursement form skill."""

from __future__ import annotations

from pathlib import Path

from playwright.async_api import Page
from pydantic import BaseModel

from app.forms.base import FormSkill
from app.forms.taxi.fill import fill_taxi
from app.forms.taxi.schema import TaxiPayload


_INSTRUCTIONS = (Path(__file__).parent / "instructions.md").read_text(encoding="utf-8")


async def _fill(page: Page, payload: BaseModel) -> None:
    assert isinstance(payload, TaxiPayload)
    await fill_taxi(page, payload)


skill = FormSkill(
    id="taxi",
    label="計程車費請領單",
    description="金控-計程車資請領單，回報每趟搭乘的時段、日期、起訖、費用與事由。",
    url=(
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=67e11db3fbb2b7a2faebc735&EMP_COMP_ID=C0"
    ),
    payload_model=TaxiPayload,
    instructions=_INSTRUCTIONS,
    fill=_fill,
)
