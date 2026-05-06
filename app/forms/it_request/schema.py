"""Pydantic schema for IT 作業申請 form."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ItRequestPayload(BaseModel):
    applicant: str = Field(
        default="",
        description="申請者姓名（留空時後端會從登入資料填入）",
    )
    reason: str = Field(description="作業原因（為什麼需要進行此次作業）", min_length=1)
    requirement: str = Field(description="需求說明（具體要做什麼、影響範圍等）", min_length=1)
    timeRange: str = Field(
        description=(
            "申請起始時間及終止時間。可用自然語言描述，例如「2026/05/10 09:00 ~ 2026/05/10 17:00」。"
        ),
        min_length=1,
    )
    operator: str = Field(description="作業人員姓名（誰實際執行作業）", min_length=1)
    result: str = Field(default="", description="執行結果說明，可為空字串（事後再填）")
