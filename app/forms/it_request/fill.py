"""Playwright fill logic for IT 作業申請 form."""

from __future__ import annotations

import asyncio

from playwright.async_api import ElementHandle, Page

from app.forms.it_request.schema import ItRequestPayload


async def _find_field_item(page: Page, label_keyword: str) -> ElementHandle | None:
    items = await page.query_selector_all("li.row-form")
    for item in items:
        label = await item.query_selector("label")
        if not label:
            continue
        text = await label.inner_text()
        if label_keyword in text:
            return item
    return None


async def _fill_text_or_textarea(item: ElementHandle, value: str) -> bool:
    """Fill the first textarea, or fall back to first text input."""
    target = await item.query_selector("textarea")
    if not target:
        target = await item.query_selector('input[type="text"]')
    if not target:
        return False
    await target.fill(value)
    await target.dispatch_event("change")
    return True


async def fill_it_request(page: Page, payload: ItRequestPayload, delay: float = 0.4) -> None:
    async def slow():
        await asyncio.sleep(delay)

    targets: list[tuple[str, str, str]] = [
        ("申請者", payload.applicant, "申請者"),
        ("作業原因", payload.reason, "作業原因"),
        ("需求說明", payload.requirement, "需求說明"),
        ("申請起始時間", payload.timeRange, "起訖時間"),
        ("作業人員", payload.operator, "作業人員"),
        ("執行結果", payload.result, "執行結果"),
    ]

    for label, value, log_name in targets:
        if not value:
            continue
        item = await _find_field_item(page, label)
        if not item:
            print(f"[it_request] 找不到欄位：{label}")
            continue
        ok = await _fill_text_or_textarea(item, value)
        if ok:
            print(f"[it_request] {log_name}: {value[:40]}{'…' if len(value) > 40 else ''}")
            await slow()
        else:
            print(f"[it_request] 欄位 {label} 沒有可填寫的輸入框")

    print("[it_request] 表單填寫完成！（提醒使用者手動上傳檔案）")
