from __future__ import annotations

import io
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass
from hashlib import sha256

from PIL import Image

from app.schemas.pipeline import PipelineResponse, RegionPayload


@dataclass(slots=True)
class Detection:
    id: str
    x: float
    y: float
    width: float
    height: float
    confidence: float


class PipelineProvider(ABC):
    name = "base"

    @abstractmethod
    def detect(self, file_bytes: bytes) -> list[Detection]:
        raise NotImplementedError

    @abstractmethod
    def inpaint(self, file_bytes: bytes, detections: list[Detection]) -> str | None:
        raise NotImplementedError

    @abstractmethod
    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        raise NotImplementedError


def _seed_from_bytes(payload: bytes) -> int:
    digest = sha256(payload).hexdigest()
    return int(digest[:8], 16)


def _mock_source_phrases() -> list[str]:
    return [
        "Oi! Matte kure!",
        "Koko wa doko da...?",
        "Zettai ni makenai.",
        "Hayaku nigete!",
        "Nani kore...",
    ]


def _translate_phrase(text: str, target_lang: str) -> str:
    dictionary = {
        "ru": {
            "Oi! Matte kure!": "Эй! Подожди меня!",
            "Koko wa doko da...?": "Где это место...?",
            "Zettai ni makenai.": "Я ни за что не проиграю.",
            "Hayaku nigete!": "Быстро беги!",
            "Nani kore...": "Что это такое...",
        },
        "en": {
            "Oi! Matte kure!": "Hey! Wait for me!",
            "Koko wa doko da...?": "Where is this place...?",
            "Zettai ni makenai.": "I will never lose.",
            "Hayaku nigete!": "Run now!",
            "Nani kore...": "What is this...?",
        },
        "es": {
            "Oi! Matte kure!": "¡Oye! ¡Espérame!",
            "Koko wa doko da...?": "¿Dónde es este lugar...?",
            "Zettai ni makenai.": "No perderé jamás.",
            "Hayaku nigete!": "¡Corre ahora!",
            "Nani kore...": "¿Qué es esto...?",
        },
    }
    return dictionary.get(target_lang, dictionary["en"]).get(text, text)


class StubProvider(PipelineProvider):
    name = "stub"

    def detect(self, file_bytes: bytes) -> list[Detection]:
        rng = random.Random(_seed_from_bytes(file_bytes))
        region_count = rng.randint(4, 8)

        detections: list[Detection] = []
        for i in range(region_count):
            x = round(rng.uniform(5, 70), 2)
            y = round(rng.uniform(5, 80), 2)
            w = round(rng.uniform(12, 25), 2)
            h = round(rng.uniform(8, 17), 2)
            if x + w > 98:
                w = round(max(4, 98 - x), 2)
            if y + h > 98:
                h = round(max(4, 98 - y), 2)
            detections.append(
                Detection(
                    id=f"r-{i + 1}",
                    x=x,
                    y=y,
                    width=w,
                    height=h,
                    confidence=round(rng.uniform(0.82, 0.97), 3),
                )
            )
        return detections

    def inpaint(self, file_bytes: bytes, detections: list[Detection]) -> str | None:
        return None

    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        phrases = _mock_source_phrases()
        return [phrases[i % len(phrases)] for i, _ in enumerate(detections)]

    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        return [_translate_phrase(text, target_lang) for text in texts]

    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        with Image.open(io.BytesIO(file_bytes)) as img:
            width, height = img.size

        detections = self.detect(file_bytes)
        source_texts = self.ocr(file_bytes, detections)
        translated_texts = self.translate(source_texts, target_lang)
        preview_url = self.inpaint(file_bytes, detections)
        regions = [
            RegionPayload(
                id=d.id,
                x=d.x,
                y=d.y,
                width=d.width,
                height=d.height,
                source_text=source_texts[idx],
                translated_text=translated_texts[idx],
                confidence=d.confidence,
            )
            for idx, d in enumerate(detections)
        ]
        return PipelineResponse(
            image_width=width,
            image_height=height,
            regions=regions,
            inpaint_preview_url=preview_url,
        )


class HuggingFaceProvider(PipelineProvider):
    name = "huggingface"

    def detect(self, file_bytes: bytes) -> list[Detection]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def inpaint(self, file_bytes: bytes, detections: list[Detection]) -> str | None:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")


class CustomProvider(PipelineProvider):
    name = "custom"

    def detect(self, file_bytes: bytes) -> list[Detection]:
        raise NotImplementedError("Custom provider is not implemented yet.")

    def inpaint(self, file_bytes: bytes, detections: list[Detection]) -> str | None:
        raise NotImplementedError("Custom provider is not implemented yet.")

    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        raise NotImplementedError("Custom provider is not implemented yet.")

    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        raise NotImplementedError("Custom provider is not implemented yet.")

    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        raise NotImplementedError("Custom provider is not implemented yet.")
