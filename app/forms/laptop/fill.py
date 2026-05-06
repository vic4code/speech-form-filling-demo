"""Playwright fill logic for 【金控】筆電申請單.

The form uses long Chinese strings as the value attribute of every
checkbox/radio. We map the AI's short keys to those exact strings here so
the AI doesn't have to reproduce them character-for-character.
"""

from __future__ import annotations

import asyncio

from playwright.async_api import ElementHandle, Page

from app.forms.laptop.schema import LaptopPayload

# Long-Chinese-string value-attribute mappings (verbatim from the live form).

NEEDS_VALUES = {
    "external_device": "需外接特殊設備（例：外接讀卡機、錄音設備……等）",
    "design_video": "需平面或3D設計、影片剪輯(例：Adobe Illustrator、威力導演……等) ",  # trailing space matches DOM
    "overseas": "需經常海外出差到網路連線不穩地區",
    "high_resource": "需跑程式語言、每日大量巨集程式……等高資源軟體",
    "none": "以上皆無",
}

APPLICANT_IS_USER_VALUES = {
    "yes": "是 (申請者與實際使用者相同)",
    "no": "否 (代替他人申請)",
}

PERM_VALUES = {
    "special_internet": "1.有申請特殊上網（討論區、社群網站等）",
    "external_msg": "2.具外部通訊軟體使用權限",
    "ndlp_whitelist": "3.有申請email NDLP郵件白名單",
    "usb_open": "4.持有的任一公發裝置，有開通USB",
    "none": "5.以上皆無",
}

RISK_VALUES = {
    "external_transfer": "1.需外接設備/專線傳輸？（例如：外接讀卡機、錄音設備、Bloomberg）",
    "trader": "2.具交易員/基金經理人身份，且確實有執行該業務者",
    "data_warehouse": "3.可一次性查詢或下載非單筆全明碼之資料，包含但不限於客戶或投資資料，具資料倉儲類系統權限，例如：EDW、SAS、HADOOP等",
    "tx_audit": "4.交易類業務觸及審核(含)後流程（例如：核保、理賠等執行業務之審核）",
    "customer_data": "5.具客戶個資新增/刪除/修改權限",
    "system_admin": "6.具存取應用系統程式碼/系統主機管理者、網路系統管理者或資料庫管理員權限",
    "none": "7.以上皆無",
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


async def _find_field_by_index(page: Page, idx: int) -> ElementHandle | None:
    items = await page.query_selector_all("li.row-form")
    return items[idx] if 0 <= idx < len(items) else None


async def _set_text(item: ElementHandle, value: str) -> bool:
    target = await item.query_selector('input[type="text"]')
    if not target:
        target = await item.query_selector("textarea")
    if not target:
        return False
    await target.fill(value)
    await target.dispatch_event("change")
    return True


async def _check_options(item: ElementHandle, values: list[str], input_type: str) -> int:
    """Click each input[type=<input_type>] whose value matches.

    Returns count of successfully clicked inputs.
    """
    clicked = 0
    for v in values:
        # Use CSS attribute selector with quoted value (escape any " in value).
        safe_v = v.replace('"', r'\"')
        sel = f'input[type="{input_type}"][value="{safe_v}"]'
        el = await item.query_selector(sel)
        if not el:
            print(f"[laptop]  選項找不到 ({input_type}): {v!r}")
            continue
        # Only click if not already checked
        is_checked = await el.is_checked()
        if not is_checked:
            await el.click()
            clicked += 1
    return clicked


async def fill_laptop(page: Page, payload: LaptopPayload, delay: float = 0.3) -> None:
    async def slow():
        await asyncio.sleep(delay)

    # 段一：選單 / 需求類型 (idx 0, checkboxes)
    item = await _find_field_item(page, "選單")
    if item and payload.needs:
        values = [NEEDS_VALUES[k] for k in payload.needs if k in NEEDS_VALUES]
        n = await _check_options(item, values, "checkbox")
        print(f"[laptop] 需求類型：勾選 {n} 項")
        await slow()

    # 段二：是否本人使用 (idx 1, radio)
    # No label text → fall back to index lookup.
    item = await _find_field_by_index(page, 1)
    if item:
        values = [APPLICANT_IS_USER_VALUES[payload.applicantIsUser]]
        n = await _check_options(item, values, "radio")
        print(f"[laptop] 申請者本人使用：{payload.applicantIsUser} (clicked {n})")
        await slow()

    # 段三：基本資料
    text_targets: list[tuple[str, str, str]] = [
        ("姓名", payload.name, "姓名"),
        ("集團員編", payload.employeeId, "集團員編"),
        ("聯絡資訊", payload.contact, "聯絡資訊"),
        ("e-mail", payload.email, "e-mail"),
        ("部門/科別", payload.location, "位置"),
        ("備註", payload.notes, "備註"),
    ]
    for label, value, log_name in text_targets:
        if not value:
            continue
        item = await _find_field_item(page, label)
        if not item:
            print(f"[laptop] 找不到欄位：{label}")
            continue
        ok = await _set_text(item, value)
        if ok:
            print(f"[laptop] {log_name}: {value}")
            await slow()

    # 段四：配件需求 (only "螢幕" checkbox)
    if payload.needScreen:
        item = await _find_field_item(page, "配件需求")
        if item:
            n = await _check_options(item, ["螢幕"], "checkbox")
            print(f"[laptop] 配件需求 螢幕：clicked={n}")
            await slow()

    # 段五：申請方案 (radio — short labels, can use as-is)
    item = await _find_field_item(page, "申請筆電方案")
    if item:
        n = await _check_options(item, [payload.plan], "radio")
        print(f"[laptop] 申請方案：{payload.plan} (clicked {n})")
        await slow()

    # 段六：特殊權限 (checkboxes)
    item = await _find_field_item(page, "特殊權限")
    if item and payload.permissions:
        values = [PERM_VALUES[k] for k in payload.permissions if k in PERM_VALUES]
        n = await _check_options(item, values, "checkbox")
        print(f"[laptop] 特殊權限：勾選 {n} 項")
        await slow()

    # 段七：風險評估 (checkboxes)
    item = await _find_field_item(page, "風險評估")
    if item and payload.risks:
        values = [RISK_VALUES[k] for k in payload.risks if k in RISK_VALUES]
        n = await _check_options(item, values, "checkbox")
        print(f"[laptop] 風險評估：勾選 {n} 項")
        await slow()

    # 段八：持有設備清單 (table + add row)
    if payload.devices:
        item = await _find_field_item(page, "持有設備清單")
        if item:
            uuid = await item.get_attribute("uuid") or ""
            for i, dev in enumerate(payload.devices):
                add_btn = await item.query_selector(f'div[name="{uuid}"][editmode="USER"]')
                if add_btn:
                    await add_btn.click()
                    await asyncio.sleep(0.4)
                tbody = await item.query_selector("tbody")
                if tbody:
                    trs = await tbody.query_selector_all("tr")
                    if i < len(trs):
                        inputs = await trs[i].query_selector_all("input")
                        values = [dev.company, dev.assetId, dev.deviceType]
                        for j, val in enumerate(values):
                            if j < len(inputs) and val:
                                await inputs[j].fill(val)
                                await inputs[j].dispatch_event("change")
                        print(f"[laptop] 設備 #{i+1}: {dev.model_dump()}")
                        await slow()

    # 段九：聲明書同意 (radio "是")
    if payload.declarationAccepted:
        item = await _find_field_item(page, "我已詳閱並同意")
        if item:
            n = await _check_options(item, ["是"], "radio")
            print(f"[laptop] 聲明書同意：clicked {n}")
            await slow()

    # 段九 b：Mac Address
    if payload.macAddress:
        item = await _find_field_item(page, "Mac Address")
        if item:
            ok = await _set_text(item, payload.macAddress)
            if ok:
                print(f"[laptop] Mac Address: {payload.macAddress}")
                await slow()

    print("[laptop] 表單填寫完成！（提醒使用者手動上傳檔案）")
