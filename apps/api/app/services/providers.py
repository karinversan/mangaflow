from __future__ import annotations

import io
import logging
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from hashlib import sha256
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw

from app.schemas.pipeline import MaskPreviewResponse, MaskRegionPayload, PipelineResponse, PointPayload, RegionPayload

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class Detection:
    id: str
    x: float
    y: float
    width: float
    height: float
    confidence: float
    label: str = "text"
    polygon: list[dict[str, float]] | None = None


@dataclass(slots=True)
class InpaintOptions:
    bubble_expand_px: int = 8
    text_expand_px: int = 3
    bubble_scale: float = 1.03
    text_scale: float = 1.0


def _resolve_inpaint_options(options: dict[str, float | int] | None = None) -> InpaintOptions:
    if not options:
        return InpaintOptions()
    return InpaintOptions(
        bubble_expand_px=int(options.get("inpaint_bubble_expand_px", 8)),
        text_expand_px=int(options.get("inpaint_text_expand_px", 3)),
        bubble_scale=float(options.get("inpaint_bubble_scale", 1.03)),
        text_scale=float(options.get("inpaint_text_scale", 1.0)),
    )


# ---------------------------------------------------------------------------
# Lazy-loaded ML models (singletons)
# ---------------------------------------------------------------------------

_yolo_model: Any = None
_manga_ocr_model: Any = None
_lama_model: Any = None

# Map YOLO class names to our internal labels
YOLO_CLASS_MAP: dict[str, str] = {
    "bubble_text": "bubble",
    "nonbubble_text": "text",
    "sfx": "text",
    "bubble": "bubble",
    "buble": "bubble",
    "text": "text",
}


def _get_yolo() -> Any:
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        from app.core.config import settings
        logger.info("Loading YOLO model from %s", settings.detection_yolo_model_path)
        _yolo_model = YOLO(settings.detection_yolo_model_path)
    return _yolo_model


def _get_manga_ocr() -> Any:
    global _manga_ocr_model
    if _manga_ocr_model is None:
        from manga_ocr import MangaOcr
        logger.info("Loading MangaOCR model")
        _manga_ocr_model = MangaOcr()
    return _manga_ocr_model


def _get_lama() -> Any:
    global _lama_model
    if _lama_model is None:
        from simple_lama_inpainting import SimpleLama
        logger.info("Loading SimpleLama inpainting model")
        _lama_model = SimpleLama()
    return _lama_model


def _translate_via_openrouter(texts: list[str], target_lang: str) -> list[str]:
    import httpx
    from app.core.config import settings

    if not settings.openrouter_api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not configured.")

    lang_names: dict[str, str] = {
        "ru": "Russian", "en": "English", "es": "Spanish",
        "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
        "de": "German", "fr": "French", "pt": "Portuguese",
        "it": "Italian", "uk": "Ukrainian", "ar": "Arabic",
    }
    lang_name = lang_names.get(target_lang, target_lang)

    numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(texts))
    prompt = (
        f"Translate the following numbered Japanese manga text lines to {lang_name}. "
        f"Return ONLY the translations, one per line, numbered the same way. "
        f"Keep sound effects expressive. Do not add explanations.\n\n{numbered}"
    )

    resp = httpx.post(
        f"{settings.openrouter_base_url}/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.openrouter_model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3,
        },
        timeout=60,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"].strip()

    lines = content.split("\n")
    results: list[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Strip leading number + dot/parenthesis
        import re
        cleaned = re.sub(r"^\d+[\.\)]\s*", "", line)
        results.append(cleaned)

    # Pad or trim to match input length
    while len(results) < len(texts):
        results.append("")
    return results[: len(texts)]


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------

class PipelineProvider(ABC):
    name = "base"

    @abstractmethod
    def detect(self, file_bytes: bytes) -> list[Detection]:
        raise NotImplementedError

    @abstractmethod
    def inpaint(self, file_bytes: bytes, detections: list[Detection], options: InpaintOptions | None = None) -> bytes | None:
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

    def preview_mask(self, file_bytes: bytes, options: dict[str, float | int] | None = None) -> MaskPreviewResponse:
        with Image.open(io.BytesIO(file_bytes)) as img:
            width, height = img.size
        detections = self.detect(file_bytes)
        regions = _detections_to_mask_regions(detections)
        return MaskPreviewResponse(image_width=width, image_height=height, regions=regions)


def _detections_to_mask_regions(detections: list[Detection]) -> list[MaskRegionPayload]:
    regions: list[MaskRegionPayload] = []
    for det in detections:
        label = "bubble" if det.label == "bubble" else "text"
        polygon = None
        if det.polygon:
            polygon = [PointPayload(x=pt["x"], y=pt["y"]) for pt in det.polygon]
        regions.append(MaskRegionPayload(
            id=det.id,
            label=label,
            x=det.x,
            y=det.y,
            width=det.width,
            height=det.height,
            confidence=det.confidence,
            polygon=polygon,
        ))
    return regions


# ---------------------------------------------------------------------------
# Stub provider
# ---------------------------------------------------------------------------

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
            label = "bubble" if i < region_count // 2 else "text"
            detections.append(
                Detection(
                    id=f"r-{i + 1}",
                    x=x,
                    y=y,
                    width=w,
                    height=h,
                    confidence=round(rng.uniform(0.82, 0.97), 3),
                    label=label,
                )
            )
        return detections

    def inpaint(self, file_bytes: bytes, detections: list[Detection], options: InpaintOptions | None = None) -> bytes | None:
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
            inpaint_preview_url=None,
        )


# ---------------------------------------------------------------------------
# HuggingFace provider (placeholder)
# ---------------------------------------------------------------------------

class HuggingFaceProvider(PipelineProvider):
    name = "huggingface"

    def detect(self, file_bytes: bytes) -> list[Detection]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def inpaint(self, file_bytes: bytes, detections: list[Detection], options: InpaintOptions | None = None) -> bytes | None:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")

    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        raise NotImplementedError("HuggingFace provider is not implemented yet.")


# ---------------------------------------------------------------------------
# Custom provider — YOLO + MangaOCR + OpenRouter + SimpleLama
# ---------------------------------------------------------------------------

class CustomProvider(PipelineProvider):
    name = "custom"

    def detect(self, file_bytes: bytes) -> list[Detection]:
        from app.core.config import settings

        model = _get_yolo()
        nparr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        h, w = img.shape[:2]

        allowed_labels = {l.strip().lower() for l in settings.detection_allowed_labels.split(",") if l.strip()}

        results = list(model.predict(
            source=img,
            conf=settings.detection_conf_threshold,
            iou=settings.detection_iou_threshold,
            retina_masks=True,
            verbose=False,
            stream=True,
        ))
        if not results:
            return []

        res = results[0]
        detections: list[Detection] = []

        if res.boxes is None or len(res.boxes) == 0:
            return []

        class_names = res.names or {}
        has_masks = res.masks is not None and len(res.masks) > 0

        for idx in range(len(res.boxes)):
            box = res.boxes[idx]
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            class_name = class_names.get(cls_id, str(cls_id)).lower()

            # Map class name to our internal label
            internal_label = YOLO_CLASS_MAP.get(class_name, None)
            if internal_label is None:
                if class_name in allowed_labels:
                    internal_label = "bubble" if "bubble" in class_name or "buble" in class_name else "text"
                else:
                    continue

            # Get bounding box in percent
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            bx = round((x1 / w) * 100, 3)
            by = round((y1 / h) * 100, 3)
            bw = round(((x2 - x1) / w) * 100, 3)
            bh = round(((y2 - y1) / h) * 100, 3)

            # Get polygon from segmentation mask if available
            polygon = None
            if has_masks:
                mask = res.masks.data[idx].cpu().numpy()
                if mask.shape != (h, w):
                    mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_NEAREST)
                mask = (mask > 0.5).astype(np.uint8)
                contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if contours:
                    largest = max(contours, key=cv2.contourArea)
                    epsilon = 0.01 * cv2.arcLength(largest, True)
                    approx = cv2.approxPolyDP(largest, epsilon, True)
                    if len(approx) >= 3:
                        polygon = [
                            {"x": round((pt[0][0] / w) * 100, 4), "y": round((pt[0][1] / h) * 100, 4)}
                            for pt in approx
                        ]

            detections.append(Detection(
                id=f"r-{idx + 1}",
                x=bx,
                y=by,
                width=bw,
                height=bh,
                confidence=round(conf, 4),
                label=internal_label,
                polygon=polygon,
            ))

        return detections

    def ocr(self, file_bytes: bytes, detections: list[Detection]) -> list[str]:
        mocr = _get_manga_ocr()
        nparr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        h, w = img.shape[:2]

        texts: list[str] = []
        for det in detections:
            x1 = max(0, int((det.x / 100) * w))
            y1 = max(0, int((det.y / 100) * h))
            x2 = min(w, int(((det.x + det.width) / 100) * w))
            y2 = min(h, int(((det.y + det.height) / 100) * h))

            if x2 <= x1 or y2 <= y1:
                texts.append("")
                continue

            crop = img[y1:y2, x1:x2]
            try:
                crop_pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                result = mocr(crop_pil)
                texts.append(result.strip())
            except Exception:
                texts.append("")

        return texts

    def translate(self, texts: list[str], target_lang: str) -> list[str]:
        if not texts:
            return []

        non_empty_indices = [i for i, t in enumerate(texts) if t.strip()]
        non_empty_texts = [texts[i] for i in non_empty_indices]

        if not non_empty_texts:
            return [""] * len(texts)

        translated_non_empty = _translate_via_openrouter(non_empty_texts, target_lang)

        result = [""] * len(texts)
        for k, idx in enumerate(non_empty_indices):
            result[idx] = translated_non_empty[k] if k < len(translated_non_empty) else ""
        return result

    def inpaint(self, file_bytes: bytes, detections: list[Detection], options: InpaintOptions | None = None) -> bytes | None:
        if not detections:
            return None

        options = options or InpaintOptions()
        lama = _get_lama()

        image = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        w, h = image.size

        mask = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(mask)

        for det in detections:
            expand_px = options.bubble_expand_px if det.label == "bubble" else options.text_expand_px
            scale = options.bubble_scale if det.label == "bubble" else options.text_scale

            cx = (det.x + det.width / 2) / 100 * w
            cy = (det.y + det.height / 2) / 100 * h
            rw = (det.width / 100 * w) * scale
            rh = (det.height / 100 * h) * scale

            x1 = max(0, int(cx - rw / 2 - expand_px))
            y1 = max(0, int(cy - rh / 2 - expand_px))
            x2 = min(w, int(cx + rw / 2 + expand_px))
            y2 = min(h, int(cy + rh / 2 + expand_px))

            if det.polygon and len(det.polygon) >= 3:
                poly = [(pt["x"] / 100 * w, pt["y"] / 100 * h) for pt in det.polygon]
                draw.polygon(poly, fill=255)
            else:
                draw.rectangle([x1, y1, x2, y2], fill=255)

        result = lama(image, mask)
        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return buf.getvalue()

    def run(self, file_bytes: bytes, target_lang: str) -> PipelineResponse:
        with Image.open(io.BytesIO(file_bytes)) as img:
            width, height = img.size

        detections = self.detect(file_bytes)
        text_detections = [d for d in detections if d.label == "text"]
        source_texts = self.ocr(file_bytes, text_detections)
        translated_texts = self.translate(source_texts, target_lang)

        import base64
        preview_bytes = self.inpaint(file_bytes, detections)
        preview_url = None
        if preview_bytes:
            preview_url = f"data:image/png;base64,{base64.b64encode(preview_bytes).decode('ascii')}"

        regions = [
            RegionPayload(
                id=d.id,
                x=d.x,
                y=d.y,
                width=d.width,
                height=d.height,
                source_text=source_texts[idx] if idx < len(source_texts) else "",
                translated_text=translated_texts[idx] if idx < len(translated_texts) else "",
                confidence=d.confidence,
            )
            for idx, d in enumerate(text_detections)
        ]
        return PipelineResponse(
            image_width=width,
            image_height=height,
            regions=regions,
            inpaint_preview_url=preview_url,
        )


# ---------------------------------------------------------------------------
# Standalone inpainting helper (used by routes)
# ---------------------------------------------------------------------------

def inpaint_with_mask_regions(image_bytes: bytes, regions: list[Any]) -> bytes | None:
    """Inpaint image using a list of mask region objects (from API request)."""
    if not regions:
        return None

    lama = _get_lama()
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = image.size
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)

    for region in regions:
        polygon = getattr(region, "polygon", None) or (region.get("polygon") if isinstance(region, dict) else None)
        rx = getattr(region, "x", None) or (region.get("x", 0) if isinstance(region, dict) else 0)
        ry = getattr(region, "y", None) or (region.get("y", 0) if isinstance(region, dict) else 0)
        rw = getattr(region, "width", None) or (region.get("width", 0) if isinstance(region, dict) else 0)
        rh = getattr(region, "height", None) or (region.get("height", 0) if isinstance(region, dict) else 0)

        if polygon and len(polygon) >= 3:
            pts = []
            for pt in polygon:
                px = getattr(pt, "x", None) or (pt.get("x", 0) if isinstance(pt, dict) else 0)
                py = getattr(pt, "y", None) or (pt.get("y", 0) if isinstance(pt, dict) else 0)
                pts.append((px / 100 * w, py / 100 * h))
            draw.polygon(pts, fill=255)
        else:
            x1 = int(rx / 100 * w)
            y1 = int(ry / 100 * h)
            x2 = int((rx + rw) / 100 * w)
            y2 = int((ry + rh) / 100 * h)
            draw.rectangle([x1, y1, x2, y2], fill=255)

    result = lama(image, mask)
    buf = io.BytesIO()
    result.save(buf, format="PNG")
    return buf.getvalue()
