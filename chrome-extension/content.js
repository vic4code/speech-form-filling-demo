// Content script: detects form fields and fills them on the active page
// Supports both standard HTML forms and XZWeb custom form components

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

function triggerReactChange(el, value) {
  const setter = el.tagName === "TEXTAREA" ? nativeTextareaSetter : nativeInputValueSetter;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function normalizeText(s) {
  return (s || "").toLowerCase().replace(/[\s_\-　]/g, "").replace(/[（(]/g, "(").replace(/[）)]/g, ")");
}

const FIELD_LABEL_ALIASES = {
  '申請原因': ['作業原因', '申請原因'],
  '作業原因': ['作業原因', '申請原因'],
  '作業時段': ['申請起始時間', '終止時間', '作業時段'],
  '申請時間': ['申請起始時間', '終止時間', '作業時段'],
  '申請起始時間及終止時間': ['申請起始時間', '終止時間', '作業時段'],
  reason: ['作業原因', '申請原因'],
  requirement: ['需求說明'],
  timeRange: ['申請起始時間', '終止時間', '作業時段'],
  operator: ['作業人員'],
  applicant: ['申請者']
};

function labelCandidates(key) {
  const raw = String(key || "");
  return [raw, ...(FIELD_LABEL_ALIASES[raw] || [])].filter(Boolean);
}

function getLabelForEl(el) {
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  const parent = el.closest("label");
  if (parent) return parent.textContent.trim();
  const prev = el.previousElementSibling;
  if (prev && prev.tagName === "LABEL") return prev.textContent.trim();
  return el.name || el.placeholder || el.id || "";
}

// ── XZWeb form detection ──
function isXZWebForm() {
  return document.querySelector("li.row-form") !== null;
}

function getXZWebFormFields() {
  const fields = [];
  const rows = document.querySelectorAll("li.row-form");

  for (const row of rows) {
    const labelEl = row.querySelector("label");
    if (!labelEl) continue;
    const label = labelEl.textContent.trim().replace(/^\*\s*/, '');

    // Radio buttons
    const radios = row.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) {
      const options = Array.from(radios).map(r => r.value);
      fields.push({ tag: 'radio-group', label, name: radios[0].name, options });
      continue;
    }

    // Dropdown (XZWeb custom)
    const dropdown = row.querySelector('.dropdown-menu-title');
    if (dropdown) {
      const items = row.querySelectorAll('.dropdown-item');
      const options = Array.from(items).map(i => i.getAttribute('value') || i.textContent.trim());
      fields.push({ tag: 'dropdown', label, options });
      continue;
    }

    // Date input
    const dateInput = row.querySelector('input[type="date"]');
    if (dateInput) {
      fields.push({ tag: 'date', label, name: dateInput.name || '', value: dateInput.value });
      continue;
    }

    // Text input
    const textInput = row.querySelector('input[type="text"]');
    if (textInput) {
      fields.push({ tag: 'text', label, name: textInput.name || '', placeholder: textInput.placeholder, value: textInput.value });
      continue;
    }

    // Textarea
    const textarea = row.querySelector('textarea');
    if (textarea) {
      fields.push({ tag: 'textarea', label, name: textarea.name || '', value: textarea.value });
      continue;
    }

    // Table (dynamic rows)
    const table = row.querySelector('table');
    if (table) {
      const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
      fields.push({ tag: 'table', label, headers });
      continue;
    }

    // Checkbox group
    const checkboxes = row.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length > 0) {
      const options = Array.from(checkboxes).map(c => ({
        value: c.value,
        label: getLabelForEl(c)
      }));
      fields.push({ tag: 'checkbox-group', label, options });
    }
  }

  return fields;
}

// ── Generic form detection ──
function getGenericFormFields() {
  const fields = [];
  const seen = new Set();

  document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select").forEach((el) => {
    const key = el.name || el.id;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);

    const label = getLabelForEl(el);
    const field = {
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      label,
      placeholder: el.placeholder || "",
      value: el.value || "",
    };

    if (el.tagName === 'SELECT') {
      field.options = Array.from(el.options).map(o => ({ value: o.value, text: o.text }));
    }

    fields.push(field);
  });

  return fields;
}

function getAllFormFields() {
  if (isXZWebForm()) {
    return { type: 'xzweb', fields: getXZWebFormFields() };
  }
  return { type: 'generic', fields: getGenericFormFields() };
}

// ── XZWeb form filling ──
function findXZWebRow(labelKeyword) {
  const rows = document.querySelectorAll("li.row-form");
  for (const row of rows) {
    const label = row.querySelector("label");
    if (label && label.textContent.includes(labelKeyword)) return row;
  }
  return null;
}

function findXZWebRowForKey(key) {
  for (const label of labelCandidates(key)) {
    const row = findXZWebRow(label);
    if (row) return row;
  }
  return null;
}

function getPrimaryTextControl(row) {
  return row.querySelector('textarea')
    || row.querySelector('input[type="text"]')
    || row.querySelector('input[type="date"]')
    || row.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox])');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fillXZWebForm(payload) {
  const results = { filled: [], failed: [] };

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || value === '') continue;

    try {
      if (key === 'ridePeriod') {
        const row = findXZWebRow('乘車時段');
        if (row) {
          const radio = row.querySelector(`input[value="${value}"]`);
          if (radio) { radio.click(); results.filled.push(key); await sleep(300); }
          else results.failed.push({ key, reason: `no radio with value "${value}"` });
        } else results.failed.push({ key, reason: 'row not found: 乘車時段' });

      } else if (key === 'rideDate') {
        const row = findXZWebRow('乘坐日期');
        if (row) {
          const inp = row.querySelector('input[type="date"]');
          if (inp) {
            triggerReactChange(inp, value);
            results.filled.push(key);
            await sleep(300);
          } else results.failed.push({ key, reason: 'date input not found' });
        } else results.failed.push({ key, reason: 'row not found: 乘坐日期' });

      } else if (key === 'rideType') {
        const row = findXZWebRow('乘坐類型');
        if (row) {
          const trigger = row.querySelector('.dropdown-menu-title');
          if (trigger) {
            trigger.click();
            await sleep(300);
            const item = row.querySelector(`.dropdown-item[value="${value}"]`);
            if (item) { item.click(); results.filled.push(key); await sleep(300); }
            else results.failed.push({ key, reason: `no dropdown item: "${value}"` });
          } else results.failed.push({ key, reason: 'dropdown trigger not found' });
        } else results.failed.push({ key, reason: 'row not found: 乘坐類型' });

      } else if (key === 'rideRows' && Array.isArray(value)) {
        const row = findXZWebRow('乘坐起迄');
        if (row) {
          const uuid = row.getAttribute('uuid') || '';
          for (let i = 0; i < value.length; i++) {
            const rideRow = value[i];
            // Click add-row button for EVERY row (table starts empty)
            const addBtn = row.querySelector(`div[name="${uuid}"][editmode="USER"]`);
            if (addBtn) { addBtn.click(); await sleep(400); }

            const tbody = row.querySelector('tbody');
            if (tbody) {
              const trs = tbody.querySelectorAll('tr');
              if (i < trs.length) {
                const inputs = trs[i].querySelectorAll('input');
                const vals = [rideRow.from, rideRow.to, rideRow.fee, rideRow.reason];
                for (let j = 0; j < vals.length && j < inputs.length; j++) {
                  if (vals[j]) triggerReactChange(inputs[j], vals[j]);
                }
                results.filled.push(`rideRows[${i}]`);
                await sleep(300);
              } else {
                results.failed.push({ key: `rideRows[${i}]`, reason: 'row not created' });
              }
            }
          }
        } else results.failed.push({ key, reason: 'row not found: 乘坐起迄' });

      } else if (key === 'totalFare') {
        const row = findXZWebRow('車資合計');
        if (row) {
          const inp = row.querySelector('input[type="text"]');
          if (inp) {
            triggerReactChange(inp, String(value).replace(/,/g, ''));
            results.filled.push(key);
            await sleep(300);
          } else results.failed.push({ key, reason: 'input not found' });
        } else results.failed.push({ key, reason: 'row not found: 車資合計' });

      } else if (key === 'notes') {
        const row = findXZWebRow('備註');
        if (row) {
          const inp = getPrimaryTextControl(row);
          if (inp) {
            triggerReactChange(inp, value);
            results.filled.push(key);
            await sleep(300);
          }
        }

      } else {
        // Try XZWeb row match by key as label keyword
        const row = findXZWebRowForKey(key);
        if (row) {
          // Checkbox group (array value)
          if (Array.isArray(value)) {
            const checkboxes = row.querySelectorAll('input[type="checkbox"]');
            if (checkboxes.length > 0) {
              for (const cb of checkboxes) {
                const cbLabel = getLabelForEl(cb) || cb.value;
                if (value.some(v => cbLabel.includes(v) || cb.value.includes(v))) {
                  if (!cb.checked) { cb.click(); await sleep(200); }
                }
              }
              results.filled.push(key);
              await sleep(300);
            } else {
              results.failed.push({ key, reason: 'no checkboxes in row' });
            }
          } else {
            // Radio group
            const radios = row.querySelectorAll('input[type="radio"]');
            if (radios.length > 0) {
              let found = false;
              for (const r of radios) {
                const rLabel = getLabelForEl(r) || r.value;
                if (rLabel.includes(String(value)) || r.value === String(value)) {
                  r.click(); found = true; await sleep(300); break;
                }
              }
              if (found) results.filled.push(key);
              else results.failed.push({ key, reason: `no radio matching "${value}"` });
            } else {
              // Text input / textarea
              const inp = getPrimaryTextControl(row);
              if (inp) {
                triggerReactChange(inp, String(value));
                results.filled.push(key);
                await sleep(300);
              } else {
                // Dropdown
                const trigger = row.querySelector('.dropdown-menu-title');
                if (trigger) {
                  trigger.click(); await sleep(300);
                  const items = row.querySelectorAll('.dropdown-item');
                  let found = false;
                  for (const item of items) {
                    if ((item.getAttribute('value') || item.textContent.trim()).includes(String(value))) {
                      item.click(); found = true; await sleep(300); break;
                    }
                  }
                  if (found) results.filled.push(key);
                  else results.failed.push({ key, reason: `no dropdown item matching "${value}"` });
                } else {
                  results.failed.push({ key, reason: 'input not found in row' });
                }
              }
            }
          }
        } else {
          // Generic fallback
          const filled = fillGenericField(key, value);
          if (filled) results.filled.push(key);
          else results.failed.push({ key, reason: 'field not found' });
        }
      }
    } catch (e) {
      results.failed.push({ key, reason: e.message });
    }
  }

  return results;
}

// ── Generic form filling ──
function fillGenericField(key, value) {
  const normKey = normalizeText(key);
  const candidates = Array.from(
    document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select")
  );

  let matched = candidates.find(el => normalizeText(el.name) === normKey || normalizeText(el.id) === normKey);
  if (!matched) {
    matched = candidates.find(el => {
      const lbl = normalizeText(getLabelForEl(el));
      return lbl && lbl.includes(normKey);
    });
  }
  if (!matched) {
    matched = candidates.find(el => normalizeText(el.placeholder).includes(normKey));
  }

  if (!matched) return false;

  const strVal = String(value);
  if (matched.tagName === "SELECT") {
    const opt = Array.from(matched.options).find(
      o => normalizeText(o.text).includes(normalizeText(strVal)) || normalizeText(o.value) === normalizeText(strVal)
    );
    if (opt) {
      matched.value = opt.value;
      matched.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  } else if (matched.type === "checkbox") {
    const checked = strVal === "true" || strVal === "1" || strVal === "yes";
    if (matched.checked !== checked) {
      matched.checked = checked;
      matched.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  } else if (matched.type === "radio") {
    const group = document.querySelectorAll(`input[type=radio][name="${CSS.escape(matched.name)}"]`);
    for (const r of group) {
      if (normalizeText(r.value) === normalizeText(strVal) || normalizeText(getLabelForEl(r)).includes(normalizeText(strVal))) {
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  } else {
    triggerReactChange(matched, strVal);
    matched.style.outline = "2px solid #10a37f";
    setTimeout(() => { matched.style.outline = ""; }, 1200);
    return true;
  }
}

function fillFields(payload) {
  if (isXZWebForm()) {
    return fillXZWebForm(payload);
  }

  // Generic fill
  const results = { filled: [], failed: [] };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || value === '') continue;
    if (fillGenericField(key, value)) {
      results.filled.push(key);
    } else {
      results.failed.push({ key, reason: 'field not found' });
    }
  }
  return results;
}

// ── Message listener ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "get_form_fields") {
    sendResponse(getAllFormFields());
    return true;
  }
  if (msg.action === "fill_form") {
    // fillXZWebForm is async, handle it
    const doFill = async () => {
      const result = await fillFields(msg.payload || {});
      sendResponse(result);
    };
    doFill();
    return true;
  }
  if (msg.action === "get_page_url") {
    sendResponse({ url: window.location.href });
    return true;
  }
  if (msg.action === "ping") {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }
});
