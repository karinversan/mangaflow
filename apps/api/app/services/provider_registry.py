from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import yaml

from app.core.config import settings

StageName = Literal["detector", "inpainter", "ocr", "translator"]


@dataclass(slots=True)
class ProviderSelection:
    provider: str
    model: str
    version: str
    params: dict[str, Any]


@dataclass(slots=True)
class ProviderHealth:
    provider: str
    ready: bool
    latency_ms: float
    error_rate: float
    checks: dict[str, Any]


_stats_lock = Lock()
_provider_stats: dict[str, dict[str, float]] = {}


def _registry_path() -> Path:
    raw = Path(settings.provider_registry_path)
    if raw.is_absolute():
        return raw
    # Keep default local to apps/api for docker and local run parity.
    return (Path(__file__).resolve().parents[2] / raw).resolve()


def load_registry() -> dict[str, Any]:
    path = _registry_path()
    if not path.exists():
        raise RuntimeError(f"Provider registry file does not exist: {path}")
    with path.open("r", encoding="utf-8") as fh:
        parsed = yaml.safe_load(fh) or {}
    defaults = parsed.get("defaults") or {}
    providers = parsed.get("providers") or {}
    if not isinstance(defaults, dict) or not isinstance(providers, dict):
        raise RuntimeError("Invalid provider registry format.")
    return {"defaults": defaults, "providers": providers}


def list_providers() -> list[dict[str, Any]]:
    registry = load_registry()
    providers: dict[str, Any] = registry["providers"]
    out: list[dict[str, Any]] = []
    for name, payload in providers.items():
        if not isinstance(payload, dict):
            continue
        out.append(
            {
                "name": name,
                "enabled": bool(payload.get("enabled", True)),
                "stages": list(payload.get("stages", [])),
                "model": str(payload.get("model", "default")),
                "version": str(payload.get("version", "v1")),
                "capabilities": list(payload.get("capabilities", [])),
            }
        )
    out.sort(key=lambda item: item["name"])
    return out


def _get_default_for_stage(stage: StageName) -> str:
    registry = load_registry()
    defaults = registry["defaults"]
    fallback = "custom"
    return str(defaults.get(stage, fallback))


def resolve_selection(stage: StageName, requested: dict[str, Any] | None = None) -> ProviderSelection:
    requested = requested or {}
    provider_name = str(requested.get("provider") or _get_default_for_stage(stage))
    model = str(requested.get("model") or "default")
    version = str(requested.get("version") or "v1")
    params = requested.get("params") or {}
    if not isinstance(params, dict):
        params = {}

    registry = load_registry()
    provider_entry = registry["providers"].get(provider_name)
    if not provider_entry:
        raise RuntimeError(f"Provider `{provider_name}` is not registered.")
    if not bool(provider_entry.get("enabled", True)):
        raise RuntimeError(f"Provider `{provider_name}` is disabled.")
    stages = provider_entry.get("stages", [])
    if stage not in stages:
        raise RuntimeError(f"Provider `{provider_name}` does not support stage `{stage}`.")

    default_model = str(provider_entry.get("model", "default"))
    default_version = str(provider_entry.get("version", "v1"))
    if model == "default":
        model = default_model
    if version == "v1":
        version = default_version
    return ProviderSelection(provider=provider_name, model=model, version=version, params=params)


def record_provider_stat(provider: str, ok: bool, latency_ms: float) -> None:
    with _stats_lock:
        stats = _provider_stats.setdefault(provider, {"calls": 0, "errors": 0, "latency_ms_sum": 0.0})
        stats["calls"] += 1
        if not ok:
            stats["errors"] += 1
        stats["latency_ms_sum"] += max(0.0, float(latency_ms))


def provider_health(provider: str) -> ProviderHealth:
    started = time.perf_counter()
    ready = True
    checks: dict[str, Any] = {"registry": True}
    error_rate = 0.0
    with _stats_lock:
        stats = _provider_stats.get(provider, {"calls": 0, "errors": 0})
        calls = float(stats.get("calls", 0))
        errors = float(stats.get("errors", 0))
        if calls > 0:
            error_rate = errors / calls
    latency_ms = (time.perf_counter() - started) * 1000
    return ProviderHealth(provider=provider, ready=ready, latency_ms=round(latency_ms, 3), error_rate=round(error_rate, 4), checks=checks)
