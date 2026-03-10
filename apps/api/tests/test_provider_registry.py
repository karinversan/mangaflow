from __future__ import annotations

from app.services.pipeline_orchestrator import resolve_pipeline_config
from app.services.provider_registry import list_providers


def test_provider_registry_lists_defaults() -> None:
    providers = list_providers()
    names = {item["name"] for item in providers}
    assert "custom" in names
    assert "stub" in names


def test_pipeline_config_resolves_defaults() -> None:
    cfg = resolve_pipeline_config({})
    assert cfg.detector.provider == "custom"
    assert cfg.inpainter.provider == "custom"
    assert cfg.ocr.provider == "custom"
    assert cfg.translator.provider == "custom"
