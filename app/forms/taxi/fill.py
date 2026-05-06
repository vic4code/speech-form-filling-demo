"""Playwright fill logic for taxi expense form."""

from __future__ import annotations

import asyncio

from playwright.async_api import ElementHandle, Page

from app.forms.taxi.schema import TaxiPayload

_RIDE_PERIOD_FALLBACK = {
    "平日日間": "01_平日(08~21)",
    "平日夜間": "02_平日(22~07)",
    "假日": "03_假日",
}


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


async def fill_taxi(page: Page, payload: TaxiPayload, delay: float = 0.4) -> None:
    async def slow():
        await asyncio.sleep(delay)

    # 1. 乘車時段
    ride_period = payload.ridePeriod
    for key, val in _RIDE_PERIOD_FALLBACK.items():
        if key in ride_period:
            ride_period = val
            break
    item = await _find_field_item(page, "乘車時段")
    if item:
        radio = await item.query_selector(f'input[value="{ride_period}"]')
        if radio:
            await radio.click()
            print(f"[taxi] 乘車時段: {ride_period}")
            await slow()

    # 2. 乘坐日期
    item = await _find_field_item(page, "乘坐日期")
    if item:
        inp = await item.query_selector('input[type="date"]')
        if inp:
            await inp.fill(payload.rideDate)
            await inp.dispatch_event("change")
            print(f"[taxi] 乘坐日期: {payload.rideDate}")
            await slow()

    # 3. 乘坐類型
    item = await _find_field_item(page, "乘坐類型")
    if item:
        trigger = await item.query_selector(".dropdown-menu-title")
        if trigger:
            await trigger.click()
            await asyncio.sleep(0.3)
            dd_item = await item.query_selector(f'.dropdown-item[value="{payload.rideType}"]')
            if dd_item:
                await dd_item.click()
                print(f"[taxi] 乘坐類型: {payload.rideType}")
                await slow()

    # 4. 乘坐起迄地點 (table with add-row button)
    item = await _find_field_item(page, "乘坐起迄")
    if item and payload.rideRows:
        uuid = await item.get_attribute("uuid") or ""
        for i, row in enumerate(payload.rideRows):
            add_btn = await item.query_selector(f'div[name="{uuid}"][editmode="USER"]')
            if add_btn:
                await add_btn.click()
                await asyncio.sleep(0.4)
            tbody = await item.query_selector("tbody")
            if tbody:
                trs = await tbody.query_selector_all("tr")
                if i < len(trs):
                    inputs = await trs[i].query_selector_all("input")
                    values = [row.from_, row.to, str(row.fee), row.reason]
                    for j, val in enumerate(values):
                        if j < len(inputs) and val:
                            await inputs[j].fill(val)
                            await inputs[j].dispatch_event("change")
                    print(f"[taxi] 乘坐明細 #{i+1}: {row.model_dump(by_alias=True)}")
                    await slow()

    # 5. 車資合計
    if payload.totalFare:
        item = await _find_field_item(page, "車資合計")
        if item:
            inp = await item.query_selector('input[type="text"]')
            if inp:
                await inp.fill(str(payload.totalFare).replace(",", ""))
                await inp.dispatch_event("change")
                print(f"[taxi] 車資合計: {payload.totalFare}")
                await slow()

    # 6. 備註
    if payload.notes:
        item = await _find_field_item(page, "備註")
        if item:
            inp = await item.query_selector('input[type="text"]')
            if inp:
                await inp.fill(payload.notes)
                await inp.dispatch_event("change")
                print(f"[taxi] 備註: {payload.notes}")
                await slow()

    print("[taxi] 表單填寫完成！")
