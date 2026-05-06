"""Browser singleton — Chrome via Playwright persistent context.

Launches Chrome once with a persistent profile (so the user only logs in
once); all subsequent fill requests reuse the same browser instance. This
module is form-agnostic: it just provides a Page navigated to a target URL
and verified ready. The actual field-filling logic lives in form skills
under `app.forms.*`.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path

from playwright.async_api import BrowserContext, Page, Playwright, async_playwright

BROWSER_PROFILE = os.path.expanduser("~/.chrome-debug-profile")

_playwright: Playwright | None = None
_context: BrowserContext | None = None
_lock = asyncio.Lock()


async def _get_context() -> BrowserContext:
    global _playwright, _context
    if _context:
        try:
            _ = _context.pages
            return _context
        except Exception:
            _context = None

    subprocess.run(["pkill", "-f", "chrome-debug-profile"], capture_output=True)
    await asyncio.sleep(1)
    lock_file = os.path.join(BROWSER_PROFILE, "SingletonLock")
    try:
        os.remove(lock_file)
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


async def open_form_page(url: str, ready_selector: str, ready_timeout_ms: int = 30_000) -> tuple[Page | None, str | None]:
    """Open or reuse a tab pointing at `url`.

    Returns (page, error). If the user is not logged in, returns
    (None, "請先登入" message). If the form fails to load, returns
    (None, error message).
    """
    async with _lock:
        try:
            ctx = await _get_context()
        except Exception as e:
            return None, f"瀏覽器啟動失敗：{e}"

        # Match by edit=<id> query parameter so different forms get different tabs.
        edit_id = _extract_edit_id(url)
        page: Page | None = None
        for pg in ctx.pages:
            if edit_id and edit_id in pg.url:
                page = pg
                break

        if not page:
            page = ctx.pages[0] if ctx.pages and not ctx.pages[0].url.startswith("http") else await ctx.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            except Exception as e:
                return None, f"無法開啟表單頁面：{e}"
        elif _extract_edit_id(page.url) != edit_id:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            except Exception as e:
                return None, f"無法切換到表單頁面：{e}"

        await asyncio.sleep(1.5)

        if "login" in page.url.lower():
            return None, "請在 Chrome 視窗中完成登入，登入後再用語音重試即可（只需登入一次）。"

        try:
            await page.wait_for_selector(ready_selector, timeout=ready_timeout_ms)
        except Exception:
            return None, "找不到表單欄位，頁面可能尚未載入完成"

        await page.bring_to_front()
        return page, None


def _extract_edit_id(url: str) -> str | None:
    if "edit=" not in url:
        return None
    return url.split("edit=", 1)[1].split("&", 1)[0]
