from __future__ import annotations

from app.core.config import settings
from app.core.resilience import CircuitBreaker, run_with_retry_timeout_circuit
from app.schemas.pipeline import MaskPreviewResponse, PipelineResponse
from app.services.pipeline_orchestrator import resolve_pipeline_config, run_orchestrated_pipeline
from app.services.providers import CustomProvider, HuggingFaceProvider, PipelineProvider, StubProvider
from app.services.providers import _resolve_inpaint_options

_circuit = CircuitBreaker(
    failure_threshold=settings.pipeline_circuit_failure_threshold,
    reset_timeout_sec=settings.pipeline_circuit_reset_sec,
)


def get_provider(provider_name: str) -> PipelineProvider:
    if provider_name == "stub":
        return StubProvider()
    if provider_name == "huggingface":
        return HuggingFaceProvider()
    if provider_name == "custom":
        return CustomProvider()
    raise ValueError(f"Unsupported provider: {provider_name}")


def run_pipeline(
    file_bytes: bytes,
    target_lang: str,
    provider_name: str,
    options: dict[str, float | int] | None = None,
    stage_config: dict | None = None,
) -> PipelineResponse:
    return run_with_retry_timeout_circuit(
        lambda: run_orchestrated_pipeline(
            file_bytes=file_bytes,
            target_lang=target_lang,
            inpaint_options=_resolve_inpaint_options(options),
            stage_config=resolve_pipeline_config(stage_config or {"detector": {"provider": provider_name}, "inpainter": {"provider": provider_name}, "ocr": {"provider": provider_name}, "translator": {"provider": provider_name}}),
        ),
        retry_count=settings.pipeline_retry_count,
        timeout_sec=settings.pipeline_job_timeout_sec,
        circuit_breaker=_circuit,
    )


def preview_mask(
    file_bytes: bytes,
    provider_name: str,
    options: dict[str, float | int] | None = None,
) -> MaskPreviewResponse:
    provider = get_provider(provider_name)
    return provider.preview_mask(file_bytes=file_bytes, options=options)


def translate_texts(
    texts: list[str],
    target_lang: str,
    provider_name: str,
) -> list[str]:
    provider = get_provider(provider_name)
    return provider.translate(texts=texts, target_lang=target_lang)
