"""Logged-in user profile.

Currently returns mock data; future versions will pull from SSO / session.
Form skills receive this profile to pre-fill personal-info fields so the AI
agent doesn't need to ask for them.
"""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BaseModel


class UserProfile(BaseModel):
    name: str
    employee_id: str
    contact: str
    email: str
    department_location: str
    company: str  # 設備所屬公司預設值

    def as_prompt_block(self) -> str:
        """Render the profile as an instruction block for the AI agent."""
        return (
            "【已登入使用者資料】（已從 SSO 取得，**請直接使用、不要詢問也不要再次確認**）：\n"
            f"- 姓名：{self.name}\n"
            f"- 集團員編：{self.employee_id}\n"
            f"- 聯絡資訊：{self.contact}\n"
            f"- e-mail：{self.email}\n"
            f"- 部門/位置：{self.department_location}\n"
            f"- 所屬公司：{self.company}\n\n"
            "上述欄位若出現在表單中，請直接填入；只在使用者明確說「替他人申請」時，"
            "才向使用者另外詢問實際使用者的資料。"
        )


@lru_cache(maxsize=1)
def get_current_profile() -> UserProfile:
    """Return the current user's profile.

    Override individual fields via env vars (USER_PROFILE_NAME, etc.) for
    quick demo customisation.
    """
    return UserProfile(
        name=os.getenv("USER_PROFILE_NAME", "陳小明"),
        employee_id=os.getenv("USER_PROFILE_EMPLOYEE_ID", "E12345"),
        contact=os.getenv("USER_PROFILE_CONTACT", "02-1234-5678 #6789"),
        email=os.getenv("USER_PROFILE_EMAIL", "xiaoming.chen@cathaylife.com.tw"),
        department_location=os.getenv(
            "USER_PROFILE_LOCATION", "資訊處/AI應用科/瑞湖金融大樓/5樓"
        ),
        company=os.getenv("USER_PROFILE_COMPANY", "國泰金控"),
    )
