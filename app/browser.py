"""Browser automation module — fills real form via Playwright persistent context.

Launches Chrome once, user logs in, browser stays alive for the entire demo session.
All subsequent fill requests reuse the same browser instance.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright, Page, BrowserContext, Playwright

# Persistent profile directory (survives restarts)
BROWSER_PROFILE = os.path.expanduser("~/.chrome-debug-profile")

FORM_URL = os.getenv(
    "FORM_URL",
    "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
    "?edit=67e11db3fbb2b7a2faebc735"
    "&case_id=69f066d6fbb2b74facc2660b"
    "&EMP_COMP_ID=C0",
)

RIDE_PERIOD_MAP = {
    "平日日間": "01_平日(08~21)",
    "平日夜間": "02_平日(22~07)",
    "假日": "03_假日",
    "01": "01_平日(08~21)",
    "02": "02_平日(22~07)",
    "03": "03_假日",
}

# ── Singleton: browser stays alive for entire session ──

_playwright: Playwright | None = None
_context: BrowserContext | None = None


async def _get_context() -> BrowserContext:
    """Get or launch persistent browser context."""
    global _playwright, _context
    if _context:
        try:
            _ = _context.pages
            return _context
        except Exception:
            _context = None

    # Kill any existing Chrome using this profile
    import subprocess
    subprocess.run(["pkill", "-f", "chrome-debug-profile"], capture_output=True)
    await asyncio.sleep(1)
    lock = os.path.join(BROWSER_PROFILE, "SingletonLock")
    try:
        os.remove(lock)
    except OSError:
        pass

    Path(BROWSER_PROFILE).mkdir(parents=True, exist_ok=True)

    _playwright = await async_playwright().start()
    _context = await _playwright.chromium.launch_persistent_context(
        user_data_dir=BROWSER_PROFILE,
        channel="chrome",
        headless=False,
        no_viewport=True,
        ignore_default_args=[
            "--use-mock-keychain",
            "--password-store=basic",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--enable-automation",
        ],
        args=["--start-maximized"],
    )
    print("[browser] Chrome 已啟動")
    return _context


# ── Helper: find field by label text ──

async def _find_field_item(page: Page, label_keyword: str):
    """Find a li.row-form element by its label text."""
    items = await page.query_selector_all("li.row-form")
    for item in items:
        label = await item.query_selector("label")
        if label:
            text = await label.inner_text()
            if label_keyword in text:
                return item
    return None


async def fill_form(page: Page, payload: dict, delay: float = 0.5) -> None:
    """Fill form fields located by label text."""
    async def slow():
        await asyncio.sleep(delay)

    # 1. 乘車時段
    ride_period = payload.get("ridePeriod", "01_平日(08~21)")
    for key, val in RIDE_PERIOD_MAP.items():
        if key in ride_period:
            ride_period = val
            break
    item = await _find_field_item(page, "乘車時段")
    if item:
        radio = await item.query_selector(f'input[value="{ride_period}"]')
        if radio:
            await radio.click()
            print(f"[browser] 乘車時段: {ride_period}")
            await slow()

    # 2. 乘坐日期
    ride_date = payload.get("rideDate", "")
    if ride_date:
        item = await _find_field_item(page, "乘坐日期")
        if item:
            inp = await item.query_selector('input[type="date"]')
            if inp:
                await inp.fill(ride_date)
                await inp.dispatch_event("change")
                print(f"[browser] 乘坐日期: {ride_date}")
                await slow()

    # 3. 乘坐類型
    ride_type = payload.get("rideType", "")
    if ride_type:
        item = await _find_field_item(page, "乘坐類型")
        if item:
            trigger = await item.query_selector(".dropdown-menu-title")
            if trigger:
                await trigger.click()
                await asyncio.sleep(0.3)
                dd_item = await item.query_selector(f'.dropdown-item[value="{ride_type}"]')
                if not dd_item:
                    if "來回" in ride_type:
                        dd_item = await item.query_selector('.dropdown-item[value="02_單日來回"]')
                    elif "多趟" in ride_type:
                        dd_item = await item.query_selector('.dropdown-item[value="03_單日多趟(請於備註說明)"]')
                    else:
                        dd_item = await item.query_selector('.dropdown-item[value="01_單日單趟"]')
                if dd_item:
                    await dd_item.click()
                    print(f"[browser] 乘坐類型: {ride_type}")
                    await slow()

    # 4. 乘坐起迄地點
    ride_rows = payload.get("rideRows", [])
    if ride_rows:
        item = await _find_field_item(page, "乘坐起迄")
        if item:
            uuid = await item.get_attribute("uuid") or ""
            for i, row in enumerate(ride_rows):
                add_btn = await item.query_selector(f'div[name="{uuid}"][editmode="USER"]')
                if add_btn:
                    await add_btn.click()
                    await asyncio.sleep(0.4)
                tbody = await item.query_selector("tbody")
                if tbody:
                    trs = await tbody.query_selector_all("tr")
                    if i < len(trs):
                        inputs = await trs[i].query_selector_all("input")
                        values = [
                            row.get("from", ""),
                            row.get("to", ""),
                            str(row.get("fee", "")),
                            row.get("reason", ""),
                        ]
                        for j, val in enumerate(values):
                            if j < len(inputs) and val:
                                await inputs[j].fill(val)
                                await inputs[j].dispatch_event("change")
                        print(f"[browser] 乘坐明細 #{i+1}: {row}")
                        await slow()

    # 5. 車資合計
    total_fare = payload.get("totalFare", "")
    if total_fare:
        item = await _find_field_item(page, "車資合計")
        if item:
            inp = await item.query_selector('input[type="text"]')
            if inp:
                await inp.fill(str(total_fare).replace(",", ""))
                await inp.dispatch_event("change")
                print(f"[browser] 車資合計: {total_fare}")
                await slow()

    # 6. 備註
    notes = payload.get("notes", "")
    if notes:
        item = await _find_field_item(page, "備註")
        if item:
            inp = await item.query_selector('input[type="text"]')
            if inp:
                await inp.fill(notes)
                await inp.dispatch_event("change")
                print(f"[browser] 備註: {notes}")
                await slow()

    print("[browser] 表單填寫完成！")


async def connect_and_fill(payload: dict) -> str:
    """Launch browser (if needed), navigate to form, and fill it."""
    try:
        ctx = await _get_context()
    except Exception as e:
        return f"瀏覽器啟動失敗：{e}"

    # Find existing form tab or open new one
    page = None
    for pg in ctx.pages:
        if "XZF0_0450" in pg.url:
            page = pg
            break

    if not page:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            await page.goto(FORM_URL, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            return f"無法開啟表單頁面：{e}"

    await asyncio.sleep(2)

    # Check login
    if "login" in page.url.lower():
        return "請在 Chrome 視窗中完成登入，登入後再用語音重試即可（只需登入一次）。"

    # Verify form loaded
    form_item = await _find_field_item(page, "乘坐日期")
    if not form_item:
        return "找不到表單欄位，頁面可能尚未載入完成"

    await page.bring_to_front()

    try:
        await fill_form(page, payload)
        return "ok"
    except Exception as e:
        return f"填寫發生錯誤：{e}"
