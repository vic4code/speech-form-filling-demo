"""Form skill registry.

Each subpackage of `app.forms` that exposes a top-level `skill: FormSkill`
object is auto-registered at import time. To add a new form:

    1. Create app/forms/<form_id>/__init__.py exposing `skill = FormSkill(...)`
    2. Done — it appears in /api/forms and is selectable in the UI.

Usage:
    from app.forms import get_skill, list_skills
    skill = get_skill("taxi")
"""

from __future__ import annotations

import importlib
import pkgutil
from typing import Iterable

from app.forms.base import FormSkill

_REGISTRY: dict[str, FormSkill] = {}


def _discover() -> None:
    package_dir = __path__  # type: ignore[name-defined]
    for info in pkgutil.iter_modules(package_dir):
        if info.name == "base" or not info.ispkg:
            continue
        module = importlib.import_module(f"{__name__}.{info.name}")
        skill = getattr(module, "skill", None)
        if isinstance(skill, FormSkill):
            if skill.id in _REGISTRY:
                raise RuntimeError(
                    f"Duplicate form skill id: {skill.id} "
                    f"(in {info.name})"
                )
            _REGISTRY[skill.id] = skill


_discover()


def get_skill(form_id: str) -> FormSkill:
    if form_id not in _REGISTRY:
        raise KeyError(f"Unknown form id: {form_id}")
    return _REGISTRY[form_id]


def list_skills() -> Iterable[FormSkill]:
    return list(_REGISTRY.values())


def has_skill(form_id: str) -> bool:
    return form_id in _REGISTRY


__all__ = ["FormSkill", "get_skill", "list_skills", "has_skill"]
