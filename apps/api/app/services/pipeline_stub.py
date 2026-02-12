from __future__ import annotations

import hashlib
import io
import random

from PIL import Image

from app.schemas.pipeline import PipelineResponse, Region


def _seed_from_bytes(payload: bytes) -> int:
    digest = hashlib.sha256(payload).hexdigest()
    return int(digest[:8], 16)


def _mock_source_phrases() -> list[str]:
    return [
        "Oi! Matte kure!",
        "Koko wa doko da...?",
        "Zettai ni makenai.",
        "Hayaku nigete!",
        "Nani kore..."
    ]


def _translate(text: str, target_lang: str) -> str:
    dictionary = {
        "ru": {
            "Oi! Matte kure!": "Эй! Подожди меня!",
            "Koko wa doko da...?": "Где это место...?",
            "Zettai ni makenai.": "Я ни за что не проиграю.",
            "Hayaku nigete!": "Быстро беги!",
            "Nani kore...": "Что это такое..."
        },
        "en": {
            "Oi! Matte kure!": "Hey! Wait for me!",
            "Koko wa doko da...?": "Where is this place...?",
            "Zettai ni makenai.": "I will never lose.",
            "Hayaku nigete!": "Run now!",
            "Nani kore...": "What is this...?"
        },
        "es": {
            "Oi! Matte kure!": "¡Oye! ¡Espérame!",
            "Koko wa doko da...?": "¿Dónde es este lugar...?",
            "Zettai ni makenai.": "No perderé jamás.",
            "Hayaku nigete!": "¡Corre ahora!",
            "Nani kore...": "¿Qué es esto...?"
        },
    }

    return dictionary.get(target_lang, dictionary["en"]).get(text, text)


def run_stub_pipeline(file_bytes: bytes, target_lang: str) -> PipelineResponse:
    seed = _seed_from_bytes(file_bytes)
    rng = random.Random(seed)

    with Image.open(io.BytesIO(file_bytes)) as img:
        width, height = img.size

    phrases = _mock_source_phrases()
    region_count = rng.randint(4, 8)

    regions: list[Region] = []
    for i in range(region_count):
        phrase = phrases[i % len(phrases)]
        x = round(rng.uniform(5, 70), 2)
        y = round(rng.uniform(5, 80), 2)
        w = round(rng.uniform(12, 25), 2)
        h = round(rng.uniform(8, 17), 2)

        if x + w > 98:
            w = round(max(4, 98 - x), 2)
        if y + h > 98:
            h = round(max(4, 98 - y), 2)

        regions.append(
            Region(
                id=f"r-{i+1}",
                x=x,
                y=y,
                width=w,
                height=h,
                source_text=phrase,
                translated_text=_translate(phrase, target_lang),
                confidence=round(rng.uniform(0.82, 0.97), 3),
            )
        )

    return PipelineResponse(
        image_width=width,
        image_height=height,
        regions=regions,
        inpaint_preview_url=None,
    )
