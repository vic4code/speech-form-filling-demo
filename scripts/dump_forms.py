"""One-shot script to dump form DOM structure for all target forms.

Run:
    uv run python scripts/dump_forms.py

Behavior:
  1. Launches Chrome using the same persistent profile as the demo
     (~/.chrome-debug-profile). If you have not logged in to staff.cathaylife
     before in this profile, you will be prompted via the Chrome window to
     log in. After login on the first URL, the script auto-navigates to the
     other URLs and dumps each form's DOM structure.
  2. Output: /tmp/form_dump.json
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path

from playwright.async_api import Page, async_playwright

PROFILE = os.path.expanduser("~/.chrome-debug-profile")

URLS: dict[str, str] = {
    "taxi": (
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=67e11db3fbb2b7a2faebc735&EMP_COMP_ID=C0"
    ),
    "it_request": (
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=6886d10efbb2b7284c267690&EMP_COMP_ID=C0"
    ),
    "laptop": (
        "https://staff.cathaylife.com.tw/XZWeb/servlet/HttpDispatcher/XZF0_0450/prompt"
        "?edit=685219a0fbb2b7651dbc0ffc&EMP_COMP_ID=C0"
    ),
}

DUMP_JS = r"""
() => {
    const fields = [];
    document.querySelectorAll('li.row-form').forEach((item, idx) => {
        const label = item.querySelector('label');
        const labelText = label ? label.innerText.trim() : '';

        // Required marker
        const requiredEl = item.querySelector('[class*="required"], .required, span.must');
        const required = !!requiredEl || /必填|\*/.test(labelText);

        // All inputs / selects / textareas
        const inputs = [...item.querySelectorAll('input, textarea, select')].map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            placeholder: el.placeholder || null,
            value: el.value || null,
            readonly: el.readOnly || false,
            disabled: el.disabled || false,
        }));

        // Native select options
        const selectOptions = [...item.querySelectorAll('select option')].map(o => ({
            value: o.value,
            text: o.innerText.trim(),
        }));

        // Custom dropdown items
        const dropdownTrigger = item.querySelector('.dropdown-menu-title');
        const dropdownItems = [...item.querySelectorAll('.dropdown-item')].map(el => ({
            value: el.getAttribute('value'),
            text: el.innerText.trim(),
        }));

        // Radio buttons
        const radios = [...item.querySelectorAll('input[type="radio"]')].map(el => {
            const wrap = el.closest('label') || el.parentElement;
            return {
                value: el.value,
                name: el.name,
                label: wrap ? wrap.innerText.trim() : null,
            };
        });

        // Checkboxes
        const checkboxes = [...item.querySelectorAll('input[type="checkbox"]')].map(el => {
            const wrap = el.closest('label') || el.parentElement;
            return {
                value: el.value,
                name: el.name,
                label: wrap ? wrap.innerText.trim() : null,
            };
        });

        // Tables (repeated rows)
        const table = item.querySelector('table');
        let tableInfo = null;
        if (table) {
            const headers = [...table.querySelectorAll('thead th, thead td')].map(th => th.innerText.trim());
            const sampleRow = table.querySelector('tbody tr');
            const sampleCells = sampleRow ? [...sampleRow.querySelectorAll('input, textarea, select')].map(el => ({
                tag: el.tagName.toLowerCase(),
                type: el.type || null,
                placeholder: el.placeholder || null,
            })) : [];
            tableInfo = { headers, sampleCells };
        }

        // Hyperlinks (related sub-pages)
        const links = [...item.querySelectorAll('a[href]')].map(a => ({
            href: a.href,
            text: a.innerText.trim(),
        }));

        // uuid attribute used by repeated-row "add" button mechanism
        const uuid = item.getAttribute('uuid') || null;
        const addBtn = uuid ? !!item.querySelector(`div[name="${uuid}"][editmode="USER"]`) : false;

        fields.push({
            idx,
            labelText,
            required,
            uuid,
            hasAddRowButton: addBtn,
            inputs,
            selectOptions: selectOptions.length ? selectOptions : null,
            hasDropdown: !!dropdownTrigger,
            dropdownItems: dropdownItems.length ? dropdownItems : null,
            radios: radios.length ? radios : null,
            checkboxes: checkboxes.length ? checkboxes : null,
            table: tableInfo,
            links: links.length ? links : null,
        });
    });

    return {
        url: location.href,
        title: document.title,
        formTitle: document.querySelector('h1, .form-title, .page-title')?.innerText.trim() || null,
        fieldCount: fields.length,
        fields,
    };
}
"""


async def dump_page(page: Page) -> dict:
    return await page.evaluate(DUMP_JS)


async def main():
    # Make sure no stale chrome from this profile
    subprocess.run(["pkill", "-f", "chrome-debug-profile"], capture_output=True)
    await asyncio.sleep(1)
    lock = os.path.join(PROFILE, "SingletonLock")
    try:
        os.remove(lock)
    except OSError:
        pass

    Path(PROFILE).mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            channel="chrome",
            headless=False,
            no_viewport=True,
            ignore_default_args=[
                "--use-mock-keychain",
                "--password-store=basic",
                "--enable-automation",
            ],
            args=["--start-maximized"],
        )
        print("[dump] Chrome launched. Profile:", PROFILE)

        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        results: dict[str, dict] = {}
        first = True

        for form_id, url in URLS.items():
            print(f"\n[dump] {form_id} → {url}")
            target = page if first else await ctx.new_page()
            try:
                await target.goto(url, wait_until="domcontentloaded", timeout=60000)
            except Exception as e:
                print(f"[dump] goto failed: {e}")
                results[form_id] = {"error": f"goto failed: {e}", "url": url}
                first = False
                continue

            # On the first URL, give user up to 10 minutes to log in.
            timeout_ms = 600_000 if first else 60_000
            try:
                await target.wait_for_selector("li.row-form", timeout=timeout_ms)
            except Exception as e:
                print(f"[dump] {form_id}: form selector not found ({e}). Saving page text instead.")
                results[form_id] = {
                    "error": f"li.row-form not found: {e}",
                    "url": target.url,
                    "bodyText": (await target.evaluate("() => document.body.innerText"))[:2000],
                }
                first = False
                continue

            # Allow late-arriving JS-rendered fields to settle
            await asyncio.sleep(2)

            data = await dump_page(target)
            results[form_id] = data
            print(f"[dump] {form_id}: {data.get('fieldCount')} fields, title={data.get('formTitle')!r}")
            first = False

        out_path = Path("/tmp/form_dump.json")
        out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(f"\n[dump] Saved → {out_path}")
        print("[dump] Closing browser in 3s...")
        await asyncio.sleep(3)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
