"""Manual end-to-end fill test.

Runs the active skill's fill() with a baked-in mock payload so you can
verify Playwright selectors before doing a full voice conversation.

Usage:
    uv run python scripts/test_fill.py taxi
    uv run python scripts/test_fill.py it_request
    uv run python scripts/test_fill.py laptop
"""

from __future__ import annotations

import asyncio
import sys

from app.browser import open_form_page
from app.forms import get_skill, list_skills

MOCKS: dict[str, dict] = {
    "taxi": {
        "ridePeriod": "01_平日(08~21)",
        "rideDate": "2026-05-06",
        "rideType": "01_單日單趟",
        "rideRows": [
            {"from": "公司", "to": "客戶辦公室", "fee": "250", "reason": "拜訪客戶"},
        ],
        "totalFare": "250",
        "notes": "測試填表",
    },
    "it_request": {
        "applicant": "陳小明",
        "reason": "資料庫例行維護",
        "requirement": "重啟 DB 服務並執行健康檢查",
        "timeRange": "2026/05/10 22:00 ~ 2026/05/11 02:00",
        "operator": "王大華",
        "result": "",
    },
    "laptop": {
        "needs": ["design_video"],
        "applicantIsUser": "yes",
        "name": "陳小明",
        "employeeId": "E12345",
        "contact": "0912-345-678",
        "email": "test@cathaylife.com.tw",
        "location": "資訊處/AI科/瑞湖大樓/5樓",
        "notes": "測試備註",
        "needScreen": True,
        "plan": "方案二",
        "permissions": ["special_internet", "external_msg"],
        "risks": ["none"],
        "devices": [
            {"company": "國泰金控", "assetId": "ASSET-001", "deviceType": "NB"},
        ],
        "declarationAccepted": True,
        "macAddress": "AA:BB:CC:DD:EE:FF",
    },
}


async def main(form_id: str) -> int:
    skill = get_skill(form_id)
    raw = MOCKS[form_id]
    payload = skill.parse_payload(raw)

    page, err = await open_form_page(skill.url, skill.ready_selector)
    if err:
        print(f"[test] open_form_page failed: {err}")
        return 1
    if page is None:
        print("[test] page is None but no error?")
        return 1

    print(f"[test] page ready, calling {form_id}.fill()...")
    await skill.fill(page, payload)
    print(f"[test] DONE. Inspect the {form_id} tab in Chrome.")
    print("[test] Browser left open — press Ctrl+C in this terminal when done.")
    # Keep alive so user can inspect
    await asyncio.sleep(600)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in MOCKS:
        print("Usage: uv run python scripts/test_fill.py <form_id>")
        print(f"Available: {[s.id for s in list_skills()]}")
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1])))
