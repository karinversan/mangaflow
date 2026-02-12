from __future__ import annotations

from app.core.config import settings
from app.core.resilience import CircuitBreaker, run_with_retry_timeout_circuit
from app.schemas.pipeline import PipelineResponse
from app.services.providers import CustomProvider, HuggingFaceProvider, PipelineProvider, StubProvider

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


def run_pipeline(file_bytes: bytes, target_lang: str, provider_name: str) -> PipelineResponse:
    provider = get_provider(provider_name)
    return run_with_retry_timeout_circuit(
        lambda: provider.run(file_bytes=file_bytes, target_lang=target_lang),
        retry_count=settings.pipeline_retry_count,
        timeout_sec=settings.pipeline_job_timeout_sec,
        circuit_breaker=_circuit,
    )
