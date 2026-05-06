"""FormSkill — uniform interface for every fillable form.

A skill bundles everything a form needs:
  - identity (id, label, description)
  - target URL
  - structured payload schema (Pydantic model → OpenAI tool schema)
  - AI conversation rules (instructions)
  - Playwright fill logic (a coroutine function)

The fill function receives a Playwright `Page`, but the rest of the skill
is executor-agnostic, so swapping in a Chrome extension executor later
only requires reimplementing fill().
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Type

from playwright.async_api import Page
from pydantic import BaseModel

from app.profile import UserProfile

FillFn = Callable[[Page, BaseModel], Awaitable[None]]
# (profile, raw_payload) → defaults to merge into raw_payload.
# Receiving raw_payload lets the form skip profile-fill conditionally
# (e.g. laptop only auto-fills when applicantIsUser="yes").
ProfileDefaultsFn = Callable[[UserProfile, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class FormSkill:
    id: str
    label: str
    description: str
    url: str
    payload_model: Type[BaseModel]
    instructions: str
    fill: FillFn
    # Selector that proves the form has finished loading; used to detect login redirects.
    ready_selector: str = "li.row-form"
    # Optional: returns {payload_field: value} to merge as fallback when AI
    # omits fields it should have pulled from the logged-in user profile.
    profile_defaults: ProfileDefaultsFn | None = None

    def merge_profile_defaults(
        self, raw: dict[str, Any], profile: UserProfile
    ) -> dict[str, Any]:
        """Fill in missing/empty fields from profile defaults.

        AI-supplied values always win; profile values only fill blanks.
        The form's profile_defaults callable can inspect `raw` to decide
        whether profile fill is appropriate (e.g. skip when filling for
        someone else).
        """
        if self.profile_defaults is None:
            return raw
        defaults = self.profile_defaults(profile, raw)
        if not defaults:
            return raw
        merged = dict(raw)
        for key, value in defaults.items():
            current = merged.get(key)
            is_empty = current is None or current == "" or current == []
            if is_empty:
                merged[key] = value
        return merged

    def tool_schema(self) -> dict[str, Any]:
        params = self.payload_model.model_json_schema()
        params.pop("title", None)
        return {
            "type": "function",
            "name": "submit_form",
            "description": (
                f"當所有欄位完整時，送出{self.label}。所有必填欄位都確認後才能呼叫。"
            ),
            "parameters": params,
        }

    def parse_payload(self, raw: dict[str, Any]) -> BaseModel:
        return self.payload_model.model_validate(raw)

    def public_meta(self) -> dict[str, Any]:
        """JSON for /api/forms — clients only need this to render the picker."""
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "url": self.url,
        }
