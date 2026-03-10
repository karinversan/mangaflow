from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any
import base64
import io

from PIL import Image

from app.core.metrics import pipeline_stage_duration_seconds, pipeline_stage_failures_total
from app.schemas.pipeline import PipelineResponse, RegionPayload
from app.services.provider_registry import ProviderSelection, record_provider_stat, resolve_selection
from app.services.providers import CustomProvider, Detection, HuggingFaceProvider, InpaintOptions, PipelineProvider, StubProvider


@dataclass(slots=True)
class ResolvedPipelineConfig:
    detector: ProviderSelection
    inpainter: ProviderSelection
    ocr: ProviderSelection
    translator: ProviderSelection


class DetectorProvider(ABC):
    @abstractmethod
    def detect(self, image_bytes: bytes, selection: ProviderSelection) -> list[Detection]:
        raise NotImplementedError


class InpainterProvider(ABC):
    @abstractmethod
    def inpaint(
        self,
        image_bytes: bytes,
        detections: list[Detection],
        options: InpaintOptions,
        selection: ProviderSelection,
    ) -> bytes | None:
        raise NotImplementedError


class OcrProvider(ABC):
    @abstractmethod
    def ocr(
        self,
        image_bytes: bytes,
        detections: list[Detection],
        selection: ProviderSelection,
        lang: str | None = None,
    ) -> list[str]:
        raise NotImplementedError


class TranslatorProvider(ABC):
    @abstractmethod
    def translate(
        self,
        texts: list[str],
        source_lang: str | None,
        target_lang: str,
        selection: ProviderSelection,
        glossary: dict[str, str] | None = None,
    ) -> list[str]:
        raise NotImplementedError


def _build_legacy_provider(name: str) -> PipelineProvider:
    if name == "stub":
        return StubProvider()
    if name == "custom":
        return CustomProvider()
    if name == "huggingface":
        return HuggingFaceProvider()
    raise RuntimeError(f"Unsupported provider `{name}`.")


class LegacyStageAdapter(DetectorProvider, InpainterProvider, OcrProvider, TranslatorProvider):
    def detect(self, image_bytes: bytes, selection: ProviderSelection) -> list[Detection]:
        provider = _build_legacy_provider(selection.provider)
        started = time.perf_counter()
        ok = False
        try:
            out = provider.detect(image_bytes)
            ok = True
            return out
        finally:
            latency = (time.perf_counter() - started) * 1000
            record_provider_stat(selection.provider, ok=ok, latency_ms=latency)
            pipeline_stage_duration_seconds.labels(stage="detect", provider=selection.provider).observe(latency / 1000)
            if not ok:
                pipeline_stage_failures_total.labels(stage="detect", provider=selection.provider).inc()

    def inpaint(
        self,
        image_bytes: bytes,
        detections: list[Detection],
        options: InpaintOptions,
        selection: ProviderSelection,
    ) -> bytes | None:
        provider = _build_legacy_provider(selection.provider)
        started = time.perf_counter()
        ok = False
        try:
            out = provider.inpaint(image_bytes, detections, options)
            ok = True
            return out
        finally:
            latency = (time.perf_counter() - started) * 1000
            record_provider_stat(selection.provider, ok=ok, latency_ms=latency)
            pipeline_stage_duration_seconds.labels(stage="inpaint", provider=selection.provider).observe(latency / 1000)
            if not ok:
                pipeline_stage_failures_total.labels(stage="inpaint", provider=selection.provider).inc()

    def ocr(
        self,
        image_bytes: bytes,
        detections: list[Detection],
        selection: ProviderSelection,
        lang: str | None = None,
    ) -> list[str]:
        provider = _build_legacy_provider(selection.provider)
        started = time.perf_counter()
        ok = False
        try:
            out = provider.ocr(image_bytes, detections)
            ok = True
            return out
        finally:
            latency = (time.perf_counter() - started) * 1000
            record_provider_stat(selection.provider, ok=ok, latency_ms=latency)
            pipeline_stage_duration_seconds.labels(stage="ocr", provider=selection.provider).observe(latency / 1000)
            if not ok:
                pipeline_stage_failures_total.labels(stage="ocr", provider=selection.provider).inc()

    def translate(
        self,
        texts: list[str],
        source_lang: str | None,
        target_lang: str,
        selection: ProviderSelection,
        glossary: dict[str, str] | None = None,
    ) -> list[str]:
        provider = _build_legacy_provider(selection.provider)
        started = time.perf_counter()
        ok = False
        try:
            out = provider.translate(texts, target_lang)
            ok = True
            return out
        finally:
            latency = (time.perf_counter() - started) * 1000
            record_provider_stat(selection.provider, ok=ok, latency_ms=latency)
            pipeline_stage_duration_seconds.labels(stage="translate", provider=selection.provider).observe(latency / 1000)
            if not ok:
                pipeline_stage_failures_total.labels(stage="translate", provider=selection.provider).inc()


def resolve_pipeline_config(requested: dict[str, Any] | None = None) -> ResolvedPipelineConfig:
    requested = requested or {}
    return ResolvedPipelineConfig(
        detector=resolve_selection("detector", requested.get("detector")),
        inpainter=resolve_selection("inpainter", requested.get("inpainter")),
        ocr=resolve_selection("ocr", requested.get("ocr")),
        translator=resolve_selection("translator", requested.get("translator")),
    )


def run_orchestrated_pipeline(
    file_bytes: bytes,
    target_lang: str,
    *,
    inpaint_options: InpaintOptions,
    stage_config: ResolvedPipelineConfig,
) -> PipelineResponse:
    adapter = LegacyStageAdapter()
    with Image.open(io.BytesIO(file_bytes)) as img:
        width, height = img.size
    detections = adapter.detect(file_bytes, stage_config.detector)
    text_detections = [det for det in detections if det.label == "text"]
    source_texts = adapter.ocr(file_bytes, text_detections, stage_config.ocr)
    translated = adapter.translate(source_texts, None, target_lang, stage_config.translator)
    preview_bytes = adapter.inpaint(file_bytes, detections, inpaint_options, stage_config.inpainter)

    preview_url = None
    if preview_bytes:
        preview_url = f"data:image/png;base64,{base64.b64encode(preview_bytes).decode('ascii')}"

    regions = [
        RegionPayload(
            id=det.id,
            x=det.x,
            y=det.y,
            width=det.width,
            height=det.height,
            source_text=source_texts[idx] if idx < len(source_texts) else "",
            translated_text=translated[idx] if idx < len(translated) else "",
            confidence=det.confidence,
        )
        for idx, det in enumerate(text_detections)
    ]
    return PipelineResponse(
        image_width=width,
        image_height=height,
        regions=regions,
        inpaint_preview_url=preview_url,
    )
