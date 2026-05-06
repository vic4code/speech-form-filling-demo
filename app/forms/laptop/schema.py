"""Pydantic schema for 【金控】筆電申請單.

Long Chinese option strings live in fill.py as a value-mapping dict; the
AI only needs to produce the short keys defined below.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

NeedKey = Literal[
    "external_device",   # 需外接特殊設備（讀卡機、錄音設備…）
    "design_video",      # 平面/3D 設計、影片剪輯
    "overseas",          # 經常海外出差到網路不穩地區
    "high_resource",     # 跑程式、大量巨集程式…等高資源軟體
    "none",              # 以上皆無
]

PermKey = Literal[
    "special_internet",  # 1.有申請特殊上網
    "external_msg",      # 2.具外部通訊軟體使用權限
    "ndlp_whitelist",    # 3.有申請 email NDLP 白名單
    "usb_open",          # 4.持有公發裝置且開通 USB
    "none",              # 5.以上皆無
]

RiskKey = Literal[
    "external_transfer",  # 1.需外接設備/專線傳輸
    "trader",             # 2.交易員/基金經理人身份
    "data_warehouse",     # 3.可一次性下載非單筆全明碼資料
    "tx_audit",           # 4.交易類業務觸及審核(含)後流程
    "customer_data",      # 5.具客戶個資新增/刪除/修改權限
    "system_admin",       # 6.具系統主機/網路/DBA 權限
    "none",               # 7.以上皆無
]


class DeviceRow(BaseModel):
    company: str = Field(description="設備所屬公司（例：國泰金控、國泰人壽）", min_length=1)
    assetId: str = Field(description="資產編號", min_length=1)
    deviceType: str = Field(description="種類，例如 PC、NB、Pad", min_length=1)


class LaptopPayload(BaseModel):
    needs: list[NeedKey] = Field(
        description=(
            "需求類型（可複選）：external_device=需外接特殊設備、design_video=設計/影片剪輯、"
            "overseas=海外出差網路不穩、high_resource=高資源軟體、none=以上皆無。"
            "若使用者表達都不符合，請填 ['none']。"
        ),
        min_length=1,
    )
    applicantIsUser: Literal["yes", "no"] = Field(
        description="是否申請者本人就是實際使用者：yes=是、no=否（代替他人申請）"
    )
    name: str = Field(
        default="",
        description="使用者姓名（若申請者本人就是使用者，留空由後端從登入資料填入）",
    )
    employeeId: str = Field(
        default="",
        description="集團員編（同上，留空由後端填入）",
    )
    contact: str = Field(
        default="",
        description="聯絡資訊，例如 02-XXXXXXXX #XXXX 或手機（同上）",
    )
    email: str = Field(
        default="",
        description="使用者 e-mail（同上）",
    )
    location: str = Field(
        default="",
        description="部門/科別/位置/樓層（同上）",
    )
    notes: str = Field(default="", description="備註，可為空字串")
    needScreen: bool = Field(
        default=False,
        description="是否需要螢幕（筆電已附滑鼠與轉接頭，僅螢幕需勾選）",
    )
    plan: Literal["方案二", "方案四"] = Field(description="申請筆電方案：方案二 或 方案四")
    permissions: list[PermKey] = Field(
        description=(
            "特殊權限（可複選）：special_internet/external_msg/ndlp_whitelist/usb_open；"
            "若都不符合請填 ['none']。"
        ),
        min_length=1,
    )
    risks: list[RiskKey] = Field(
        description=(
            "風險評估（可複選）：external_transfer/trader/data_warehouse/tx_audit/"
            "customer_data/system_admin；若都不符合請填 ['none']。"
        ),
        min_length=1,
    )
    devices: list[DeviceRow] = Field(
        default_factory=list,
        description="持有設備清單（主要及兼任公司 PC、NB 等），可為空陣列",
    )
    declarationAccepted: bool = Field(
        description="使用者是否同意聲明書（必須為 true 才能送出）"
    )
    macAddress: str = Field(default="", description="筆電 Mac Address，可為空字串")
