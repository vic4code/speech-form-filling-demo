"""Pydantic schema for taxi expense reimbursement form.

Field IDs and option codes mirror the XZWeb form value attributes — the
fill function uses them verbatim, so the AI must produce these exact codes.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class RideRow(BaseModel):
    from_: str = Field(alias="from", description="乘坐起點", min_length=1)
    to: str = Field(description="乘坐迄點", min_length=1)
    fee: str = Field(description="費用（純數字字串）")
    reason: str = Field(description="乘坐事由", min_length=1)

    model_config = {"populate_by_name": True}


class TaxiPayload(BaseModel):
    ridePeriod: Literal["01_平日(08~21)", "02_平日(22~07)", "03_假日"] = Field(
        description=(
            "乘車時段：平日白天=01_平日(08~21)、平日晚上=02_平日(22~07)、"
            "假日=03_假日。若使用者未提及預設為 01_平日(08~21)。"
        )
    )
    rideDate: str = Field(
        description="乘坐日期，格式必須為 YYYY-MM-DD，例如 2026-04-28。",
        pattern=r"^\d{4}-\d{2}-\d{2}$",
    )
    rideType: Literal["01_單日單趟", "02_單日來回", "03_單日多趟(請於備註說明)"] = Field(
        description="乘坐類型：單趟=01_單日單趟、來回=02_單日來回、多趟=03_單日多趟(請於備註說明)。"
    )
    rideRows: list[RideRow] = Field(
        description="乘坐起迄明細，至少一筆", min_length=1
    )
    totalFare: str = Field(description="當日車資合計（純數字字串）")
    notes: str = Field(default="", description="備註說明，可為空字串")
