"""Guardrail module.

Text Guardrail: Local keyword patterns + LiteLLM → Bedrock (if available)
Audio Guardrail: LiteLLM → AudioGuardrailHook (monkey patch via callbacks config)
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class GuardrailResult:
    passed: bool
    check_type: str  # "input_audio" | "input_text" | "output_text"
    message: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


# ── Local keyword-based guardrail ──

_BLOCK_PATTERNS: list[tuple[str, re.Pattern]] = [
    # Prompt injection (traditional + simplified)
    ("Prompt injection", re.compile(
        r"(忽略|無視|无视|跳過|跳过|覆蓋|覆盖|override).{0,6}(指令|instructions|prompt|規則|规则|設定|设定)|"
        r"ignore.{0,10}(previous|above|prior|system)|"
        r"jailbreak|DAN|do anything now|角色劫持|扮演.{0,4}(壞人|坏人|駭客|黑客|惡意|恶意)",
        re.IGNORECASE,
    )),
    # PII / data exfiltration (traditional + simplified)
    ("Data exfiltration", re.compile(
        r"(列出|顯示|显示|給我|给我).{0,6}(所有|全部).{0,6}(使用者|用戶|用户|帳號|账号|密碼|密码|資料|资料)|"
        r"(API|api).?key|access.?token|密[碼码]是什[麼么]",
        re.IGNORECASE,
    )),
    # Abuse / profanity (Chinese traditional + simplified + English)
    ("Abuse", re.compile(
        r"[幹干]你[娘媽妈妹]|操你[媽妈妹爸]|去死|王八蛋|狗娘養|狗娘养|"
        r"[他她]媽的|[他她]妈的|靠北|機掰|机掰|傻[逼比]|混蛋|[滾滚]蛋|白癡|白痴|"
        r"fuck\s*you|shit|bitch|asshole|kill\s*yourself|去你的|妈的|媽的",
        re.IGNORECASE,
    )),
    # Violence / crime (traditional + simplified)
    ("Violence", re.compile(
        r"(做|製作|制作|製造|制造|組裝|组装).{0,4}(炸[彈弹]|炸[藥药]|武器|[槍枪]|毒品)|"
        r"(搶劫|抢劫|綁架|绑架|殺[人了掉]|杀[人了掉]|暗殺|暗杀|放火|縱火|纵火|強暴|强暴|販毒|贩毒|走私)",
        re.IGNORECASE,
    )),
    # Expense fraud (traditional + simplified)
    ("Expense fraud", re.compile(
        r"(多報|多报|虛報|虚报|灌水|偽造|伪造|竄改|篡改).{0,4}(金額|金额|費用|费用|發票|发票|收據|收据)|"
        r"不要留.{0,4}[紀纪記记][錄录]|假[發发]票|假收[據据]",
        re.IGNORECASE,
    )),
    # Code injection
    ("Code injection", re.compile(
        r"DROP\s+TABLE|<script|UNION\s+SELECT|1\s*=\s*1|eval\s*\(|exec\s*\(",
        re.IGNORECASE,
    )),
]

# Load custom keywords from env
_custom_kw = os.getenv("GUARDRAIL_BLOCK_KEYWORDS", "")
if _custom_kw:
    kw_list = [k.strip() for k in _custom_kw.split(",") if k.strip()]
    if kw_list:
        _BLOCK_PATTERNS.append((
            "Custom keyword",
            re.compile("|".join(re.escape(k) for k in kw_list), re.IGNORECASE),
        ))


def check_text_local(text: str) -> tuple[bool, str]:
    """Check text against local keyword patterns.

    Returns (passed, reason). Fast, no network call.
    """
    if not text or not text.strip():
        return True, ""
    for category, pattern in _BLOCK_PATTERNS:
        m = pattern.search(text)
        if m:
            return False, f"{category}: matched '{m.group()}'"
    return True, ""
