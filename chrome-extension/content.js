// Content script: fills form fields on the active page

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

function triggerReactChange(el, value) {
  if (el.tagName === "TEXTAREA") {
    if (nativeTextareaSetter) {
      nativeTextareaSetter.call(el, value);
    } else {
      el.value = value;
    }
  } else {
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function normalizeText(s) {
  return (s || "").toLowerCase().replace(/[\s_\-　]/g, "").replace(/[（(]/g, "(").replace(/[）)]/g, ")");
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

function getAllFormFields() {
  const fields = [];
  document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select").forEach((el) => {
    const label = getLabelForEl(el);
    fields.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      name: el.name || "",
      id: el.id || "",
      label,
      placeholder: el.placeholder || "",
      value: el.value || "",
    });
  });
  return fields;
}

function fillFields(payload) {
  const results = { filled: [], failed: [] };

  const candidates = Array.from(
    document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select")
  );

  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || value === "") continue;
    const normKey = normalizeText(key);
    let matched = null;

    matched = candidates.find((el) => normalizeText(el.name) === normKey || normalizeText(el.id) === normKey);

    if (!matched) {
      matched = candidates.find((el) => {
        const lbl = normalizeText(getLabelForEl(el));
        return lbl && lbl.includes(normKey);
      });
    }

    if (!matched) {
      matched = candidates.find((el) => normalizeText(el.placeholder).includes(normKey));
    }

    if (matched) {
      try {
        const strVal = String(value);
        if (matched.tagName === "SELECT") {
          const opt = Array.from(matched.options).find(
            (o) => normalizeText(o.text).includes(normalizeText(strVal)) || normalizeText(o.value) === normalizeText(strVal)
          );
          if (opt) {
            matched.value = opt.value;
            matched.dispatchEvent(new Event("change", { bubbles: true }));
            results.filled.push(key);
          } else {
            results.failed.push({ key, reason: "no matching option" });
          }
        } else if (matched.type === "checkbox") {
          const checked = strVal === "true" || strVal === "1" || strVal === "yes";
          if (matched.checked !== checked) {
            matched.checked = checked;
            matched.dispatchEvent(new Event("change", { bubbles: true }));
          }
          results.filled.push(key);
        } else if (matched.type === "radio") {
          const group = document.querySelectorAll(`input[type=radio][name="${CSS.escape(matched.name)}"]`);
          let found = false;
          group.forEach((r) => {
            if (normalizeText(r.value) === normalizeText(strVal) || normalizeText(getLabelForEl(r)).includes(normalizeText(strVal))) {
              r.checked = true;
              r.dispatchEvent(new Event("change", { bubbles: true }));
              found = true;
            }
          });
          if (found) results.filled.push(key);
          else results.failed.push({ key, reason: "no matching radio" });
        } else {
          triggerReactChange(matched, strVal);
          // Highlight briefly
          const prev = matched.style.outline;
          matched.style.outline = "2px solid #10a37f";
          setTimeout(() => { matched.style.outline = prev; }, 1200);
          results.filled.push(key);
        }
      } catch (e) {
        results.failed.push({ key, reason: e.message });
      }
    } else {
      results.failed.push({ key, reason: "field not found" });
    }
  }
  return results;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "get_form_fields") {
    sendResponse({ fields: getAllFormFields() });
    return true;
  }
  if (msg.action === "fill_form") {
    const result = fillFields(msg.payload || {});
    sendResponse(result);
    return true;
  }
  if (msg.action === "ping") {
    sendResponse({ ok: true, url: window.location.href });
    return true;
  }
});
