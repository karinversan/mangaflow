#!/usr/bin/env python3
"""
Pipeline evaluation / benchmark script for the manga translation pipeline.

Subcommands
-----------
  segment-eval   Evaluate YOLO segmentation against a labelled YOLO-format dataset
  ocr-label      Run MangaOCR on detected regions and export editable JSON labels
  ocr-eval       Evaluate OCR quality (CER / WER) against corrected JSON labels
  translate-eval Evaluate translation quality (BLEU / chrF) against reference translations
  full-benchmark Run the full pipeline on a set of images and measure time per stage

Usage examples
--------------
  python scripts/evaluate_pipeline.py segment-eval \
      --data-yaml path/to/data.yaml \
      --model-path apps/api/models/yolo26s-seg.pt

  python scripts/evaluate_pipeline.py ocr-label \
      --images-dir path/to/images \
      --model-path apps/api/models/yolo26s-seg.pt

  python scripts/evaluate_pipeline.py ocr-eval \
      --labels-dir scripts/ocr_labels \
      --split val

  python scripts/evaluate_pipeline.py full-benchmark \
      --images-dir path/to/images \
      --model-path apps/api/models/yolo26s-seg.pt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Helpers: metrics
# ---------------------------------------------------------------------------

def _levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein edit distance between two strings."""
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            temp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + cost)
            prev = temp
    return dp[m]


def char_error_rate(reference: str, hypothesis: str) -> float:
    """Character Error Rate = edit_distance(ref, hyp) / len(ref)."""
    ref = (reference or "").strip()
    hyp = (hypothesis or "").strip()
    if len(ref) == 0:
        return 0.0 if len(hyp) == 0 else 1.0
    return _levenshtein(ref, hyp) / len(ref)


def word_error_rate(reference: str, hypothesis: str) -> float:
    """Word Error Rate = edit_distance(ref_words, hyp_words) / len(ref_words)."""
    ref_words = (reference or "").strip().split()
    hyp_words = (hypothesis or "").strip().split()
    if len(ref_words) == 0:
        return 0.0 if len(hyp_words) == 0 else 1.0
    # Reuse levenshtein on word lists via join with a unique separator
    return _levenshtein_seq(ref_words, hyp_words) / len(ref_words)


def _levenshtein_seq(a: list, b: list) -> int:
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            temp = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + cost)
            prev = temp
    return dp[m]


def dice_score_binary(pred: np.ndarray, gt: np.ndarray, eps: float = 1e-7) -> float:
    pred_b = pred.astype(bool)
    gt_b = gt.astype(bool)
    inter = np.logical_and(pred_b, gt_b).sum()
    denom = pred_b.sum() + gt_b.sum()
    return float((2.0 * inter + eps) / (denom + eps))


def iou_score_binary(pred: np.ndarray, gt: np.ndarray, eps: float = 1e-7) -> float:
    pred_b = pred.astype(bool)
    gt_b = gt.astype(bool)
    inter = np.logical_and(pred_b, gt_b).sum()
    union = np.logical_or(pred_b, gt_b).sum()
    return float((inter + eps) / (union + eps))


# ---------------------------------------------------------------------------
# Helpers: YOLO label parsing
# ---------------------------------------------------------------------------

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def list_images(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.suffix.lower() in IMG_EXTS)


def read_yolo_seg_objects(label_path: Path, img_h: int, img_w: int) -> list[dict]:
    """Parse a YOLO segmentation label file.

    Each line: class_id x1 y1 x2 y2 ... xN yN  (normalised 0-1 polygon coords)
    Returns list of {"cls": int, "poly": np.ndarray shape (N,2) in pixel coords}.
    """
    objects: list[dict] = []
    if not label_path.exists():
        return objects
    text = label_path.read_text(encoding="utf-8").strip()
    if not text:
        return objects
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) < 7:
            continue
        cls_id = int(float(parts[0]))
        coords = list(map(float, parts[1:]))
        if len(coords) % 2 != 0:
            continue
        pts = np.array(coords, dtype=np.float32).reshape(-1, 2)
        pts[:, 0] *= img_w
        pts[:, 1] *= img_h
        pts = np.round(pts).astype(np.int32)
        objects.append({"cls": cls_id, "poly": pts})
    return objects


def build_class_masks(label_path: Path, img_shape: tuple, num_classes: int) -> np.ndarray:
    """Build per-class binary masks from a YOLO seg label.

    Returns ndarray of shape (num_classes, H, W) with dtype uint8.
    """
    h, w = img_shape[:2]
    masks = np.zeros((num_classes, h, w), dtype=np.uint8)
    for obj in read_yolo_seg_objects(label_path, h, w):
        cls_id = obj["cls"]
        if 0 <= cls_id < num_classes:
            poly = obj["poly"].reshape(-1, 1, 2)
            cv2.fillPoly(masks[cls_id], [poly], 1)
    return masks


def bbox_from_polygon(poly_pts: np.ndarray, h: int, w: int, pad: int = 4) -> tuple[int, int, int, int] | None:
    """Get bounding box (x1,y1,x2,y2) from polygon points."""
    if len(poly_pts) == 0:
        return None
    xs = poly_pts[:, 0]
    ys = poly_pts[:, 1]
    x1 = max(0, int(xs.min()) - pad)
    y1 = max(0, int(ys.min()) - pad)
    x2 = min(w, int(xs.max()) + pad)
    y2 = min(h, int(ys.max()) + pad)
    if x2 <= x1 or y2 <= y1:
        return None
    return x1, y1, x2, y2


# ---------------------------------------------------------------------------
# Helpers: model loading (standalone, no app dependencies)
# ---------------------------------------------------------------------------

_yolo_model: Any = None
_manga_ocr_model: Any = None
_lama_model: Any = None


def get_yolo(model_path: str) -> Any:
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        print(f"[info] Loading YOLO model from {model_path}")
        _yolo_model = YOLO(model_path)
    return _yolo_model


def get_manga_ocr() -> Any:
    global _manga_ocr_model
    if _manga_ocr_model is None:
        from manga_ocr import MangaOcr
        print("[info] Loading MangaOCR model")
        _manga_ocr_model = MangaOcr()
    return _manga_ocr_model


def get_lama() -> Any:
    global _lama_model
    if _lama_model is None:
        from simple_lama_inpainting import SimpleLama
        print("[info] Loading SimpleLama model")
        _lama_model = SimpleLama()
    return _lama_model


# ---------------------------------------------------------------------------
# Helpers: output
# ---------------------------------------------------------------------------

def _save_report(report: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"[info] Report saved to {out_path}")


def _print_table(headers: list[str], rows: list[list], col_widths: list[int] | None = None) -> None:
    """Print a simple ASCII table."""
    if col_widths is None:
        col_widths = [max(len(str(h)), *(len(str(r[i])) for r in rows)) + 2 for i, h in enumerate(headers)]
    header_line = "".join(str(h).ljust(w) for h, w in zip(headers, col_widths))
    separator = "-" * len(header_line)
    print(separator)
    print(header_line)
    print(separator)
    for row in rows:
        print("".join(str(c).ljust(w) for c, w in zip(row, col_widths)))
    print(separator)


# ===================================================================
# SUBCOMMAND: segment-eval
# ===================================================================

def cmd_segment_eval(args: argparse.Namespace) -> None:
    """Evaluate YOLO segmentation model using a labelled YOLO-format dataset.

    Computes per-class and mean: mAP50, mAP50-95 (via ultralytics val),
    plus pixel-level Dice and IoU on the val/test split.
    """
    from tqdm import tqdm

    data_yaml = Path(args.data_yaml).resolve()
    model_path = Path(args.model_path).resolve()
    split = args.split  # "val" or "test"
    imgsz = args.imgsz
    conf = args.conf
    iou_thresh = args.iou

    print(f"\n{'=' * 60}")
    print(f"  SEGMENTATION EVALUATION")
    print(f"  Model : {model_path}")
    print(f"  Data  : {data_yaml}")
    print(f"  Split : {split}")
    print(f"{'=' * 60}\n")

    # ---- 1. Run ultralytics val for mAP metrics ----
    from ultralytics import YOLO
    import yaml

    model = YOLO(str(model_path))

    t0 = time.perf_counter()
    val_metrics = model.val(
        data=str(data_yaml),
        split=split,
        imgsz=imgsz,
        conf=conf,
        iou=iou_thresh,
        verbose=False,
    )
    val_time = time.perf_counter() - t0

    # Extract metrics from results_dict
    results_dict: dict[str, float] = {}
    if hasattr(val_metrics, "results_dict"):
        for k, v in val_metrics.results_dict.items():
            try:
                results_dict[k] = round(float(v), 5)
            except Exception:
                pass

    # Also try structured accessors
    for prefix in ("seg", "box"):
        obj = getattr(val_metrics, prefix, None)
        if obj is not None:
            for attr in ("map", "map50", "mp", "mr"):
                if hasattr(obj, attr):
                    try:
                        results_dict[f"{prefix}.{attr}"] = round(float(getattr(obj, attr)), 5)
                    except Exception:
                        pass

    # ---- 2. Parse data yaml to find images/labels ----
    with open(data_yaml, "r", encoding="utf-8") as f:
        data_cfg = yaml.safe_load(f)

    dataset_root = Path(data_cfg.get("path", data_yaml.parent))
    split_images_rel = data_cfg.get(split, data_cfg.get("val", "val/images"))
    split_images_dir = dataset_root / split_images_rel
    # Derive labels dir: swap "images" for "labels"
    split_labels_dir = Path(str(split_images_dir).replace("/images", "/labels"))

    if not split_images_dir.exists():
        print(f"[warn] Images dir not found: {split_images_dir}")
        print("  Skipping pixel-level Dice/IoU evaluation.")
        _save_report({"ultralytics_metrics": results_dict, "val_time_sec": round(val_time, 3)},
                      Path(args.report_out))
        return

    class_names = []
    names_cfg = data_cfg.get("names", {})
    if isinstance(names_cfg, dict):
        class_names = [names_cfg[i] for i in sorted(names_cfg.keys())]
    elif isinstance(names_cfg, list):
        class_names = list(names_cfg)
    num_classes = len(class_names)

    # ---- 3. Pixel-level Dice and IoU ----
    images = list_images(split_images_dir)
    print(f"[info] Computing pixel-level Dice/IoU on {len(images)} images ...")

    dice_sum = np.zeros(num_classes, dtype=np.float64)
    iou_sum = np.zeros(num_classes, dtype=np.float64)
    count = np.zeros(num_classes, dtype=np.int64)

    pred_results = list(model.predict(
        source=str(split_images_dir),
        imgsz=imgsz,
        conf=conf,
        iou=iou_thresh,
        retina_masks=True,
        stream=True,
        verbose=False,
    ))

    for res in tqdm(pred_results, desc="Dice/IoU"):
        img_path = Path(res.path)
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]

        label_path = split_labels_dir / f"{img_path.stem}.txt"
        gt_masks = build_class_masks(label_path, img.shape, num_classes)

        pred_masks = np.zeros_like(gt_masks, dtype=np.uint8)
        if res.masks is not None and res.boxes is not None and len(res.boxes) > 0:
            p_masks = res.masks.data.detach().cpu().numpy()
            p_cls = res.boxes.cls.detach().cpu().numpy().astype(int)
            for mask_arr, cls_id in zip(p_masks, p_cls):
                if 0 <= cls_id < num_classes:
                    if mask_arr.shape != (h, w):
                        mask_arr = cv2.resize(mask_arr, (w, h), interpolation=cv2.INTER_NEAREST)
                    pred_masks[cls_id] = np.maximum(pred_masks[cls_id], (mask_arr > 0.5).astype(np.uint8))

        for cls_id in range(num_classes):
            gt = gt_masks[cls_id]
            pred = pred_masks[cls_id]
            if gt.sum() == 0 and pred.sum() == 0:
                continue
            dice_sum[cls_id] += dice_score_binary(pred, gt)
            iou_sum[cls_id] += iou_score_binary(pred, gt)
            count[cls_id] += 1

    # ---- 4. Print results ----
    safe_count = np.maximum(count, 1)
    dice_per_class = dice_sum / safe_count
    iou_per_class = iou_sum / safe_count

    headers = ["Class", "Dice", "IoU", "Images"]
    rows = []
    for i in range(num_classes):
        rows.append([
            class_names[i],
            f"{dice_per_class[i]:.4f}",
            f"{iou_per_class[i]:.4f}",
            str(count[i]),
        ])
    mean_dice = float(dice_per_class[count > 0].mean()) if (count > 0).any() else 0.0
    mean_iou = float(iou_per_class[count > 0].mean()) if (count > 0).any() else 0.0
    rows.append(["MEAN", f"{mean_dice:.4f}", f"{mean_iou:.4f}", ""])

    print("\n--- Pixel-level Segmentation Metrics ---")
    _print_table(headers, rows)

    print("\n--- Ultralytics Val Metrics ---")
    for k, v in sorted(results_dict.items()):
        print(f"  {k:30s} {v:.5f}")
    print(f"\n  Val run time: {val_time:.2f}s")

    # ---- 5. Save report ----
    report = {
        "model_path": str(model_path),
        "data_yaml": str(data_yaml),
        "split": split,
        "val_time_sec": round(val_time, 3),
        "ultralytics_metrics": results_dict,
        "pixel_metrics": {
            "class_names": class_names,
            "dice_per_class": [round(float(d), 5) for d in dice_per_class],
            "iou_per_class": [round(float(d), 5) for d in iou_per_class],
            "images_per_class": count.tolist(),
            "mean_dice": round(mean_dice, 5),
            "mean_iou": round(mean_iou, 5),
        },
    }
    _save_report(report, Path(args.report_out))


# ===================================================================
# SUBCOMMAND: ocr-label
# ===================================================================

def cmd_ocr_label(args: argparse.Namespace) -> None:
    """Run MangaOCR on all detected text regions and save editable JSON labels.

    For each image, produces a JSON file in --output-dir with the structure:
    {
      "image_path": "...",
      "regions": [
        {"id": "r-1", "bbox": [x1, y1, x2, y2], "class_name": "...", "ocr_text": "..."}
      ]
    }

    The user can manually edit "ocr_text" fields and then run `ocr-eval`.
    """
    from tqdm import tqdm

    images_dir = Path(args.images_dir).resolve()
    model_path = Path(args.model_path).resolve()
    output_dir = Path(args.output_dir).resolve()
    conf = args.conf
    iou_thresh = args.iou
    imgsz = args.imgsz

    # If a YOLO dataset yaml + labels dir are provided, use GT polygons for cropping
    use_gt = args.labels_dir is not None
    labels_dir = Path(args.labels_dir).resolve() if args.labels_dir else None
    data_yaml_path = Path(args.data_yaml).resolve() if args.data_yaml else None

    # Resolve class names
    class_names: list[str] = []
    num_classes = 0
    if data_yaml_path and data_yaml_path.exists():
        import yaml
        with open(data_yaml_path, "r", encoding="utf-8") as f:
            dcfg = yaml.safe_load(f)
        names_cfg = dcfg.get("names", {})
        if isinstance(names_cfg, dict):
            class_names = [names_cfg[i] for i in sorted(names_cfg.keys())]
        elif isinstance(names_cfg, list):
            class_names = list(names_cfg)
        num_classes = len(class_names)

    output_dir.mkdir(parents=True, exist_ok=True)
    images = list_images(images_dir)

    if not images:
        print(f"[error] No images found in {images_dir}")
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print(f"  OCR LABELLING")
    print(f"  Images    : {images_dir} ({len(images)} files)")
    print(f"  Output    : {output_dir}")
    print(f"  Source    : {'GT labels' if use_gt else 'YOLO predictions'}")
    print(f"{'=' * 60}\n")

    mocr = get_manga_ocr()

    # Optionally load YOLO for prediction-based cropping
    yolo_model = None
    if not use_gt:
        yolo_model = get_yolo(str(model_path))

    total_regions = 0
    total_time = 0.0

    for img_path in tqdm(images, desc="OCR labelling"):
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]

        regions_data: list[dict] = []

        if use_gt and labels_dir:
            label_path = labels_dir / f"{img_path.stem}.txt"
            objs = read_yolo_seg_objects(label_path, h, w)
            for idx, obj in enumerate(objs):
                bbox = bbox_from_polygon(obj["poly"], h, w, pad=6)
                if bbox is None:
                    continue
                x1, y1, x2, y2 = bbox
                cls_name = class_names[obj["cls"]] if obj["cls"] < len(class_names) else str(obj["cls"])
                regions_data.append({
                    "id": f"r-{idx + 1}",
                    "bbox": [x1, y1, x2, y2],
                    "class_id": obj["cls"],
                    "class_name": cls_name,
                })
        else:
            # Use YOLO predictions
            results = list(yolo_model.predict(
                source=img,
                imgsz=imgsz,
                conf=conf,
                iou=iou_thresh,
                retina_masks=True,
                verbose=False,
                stream=True,
            ))
            if results and results[0].boxes is not None and len(results[0].boxes) > 0:
                res = results[0]
                model_names = res.names or {}
                for idx in range(len(res.boxes)):
                    box = res.boxes[idx]
                    cls_id = int(box.cls[0].item())
                    cls_name = model_names.get(cls_id, str(cls_id))
                    x1, y1, x2, y2 = [int(c) for c in box.xyxy[0].tolist()]
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(w, x2), min(h, y2)
                    if x2 <= x1 or y2 <= y1:
                        continue
                    regions_data.append({
                        "id": f"r-{idx + 1}",
                        "bbox": [x1, y1, x2, y2],
                        "class_id": cls_id,
                        "class_name": cls_name,
                    })

        # Run OCR on each region
        for region in regions_data:
            x1, y1, x2, y2 = region["bbox"]
            crop = img[y1:y2, x1:x2]
            if crop.size == 0:
                region["ocr_text"] = ""
                continue
            try:
                crop_pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                t0 = time.perf_counter()
                text = mocr(crop_pil).strip()
                total_time += time.perf_counter() - t0
                region["ocr_text"] = text
            except Exception:
                region["ocr_text"] = ""

        total_regions += len(regions_data)

        # Save per-image JSON
        out_json = output_dir / f"{img_path.stem}.json"
        label_doc = {
            "image_path": str(img_path),
            "image_width": w,
            "image_height": h,
            "regions": regions_data,
        }
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(label_doc, f, ensure_ascii=False, indent=2)

    print(f"\n[done] Processed {len(images)} images, {total_regions} regions.")
    print(f"  OCR inference time: {total_time:.2f}s ({total_regions / max(total_time, 1e-9):.1f} regions/sec)")
    print(f"  Labels saved to: {output_dir}")
    print(f"\n  Edit the 'ocr_text' fields in the JSON files, then run `ocr-eval`.")


# ===================================================================
# SUBCOMMAND: ocr-eval
# ===================================================================

def cmd_ocr_eval(args: argparse.Namespace) -> None:
    """Evaluate OCR quality against corrected JSON labels (CER, WER).

    Expects JSON files produced by `ocr-label`, where the user has filled in
    a "ocr_text_corrected" field (or kept "ocr_text" as both pred and ref
    if a separate --refs-dir with corrected copies is given).
    """
    from tqdm import tqdm

    labels_dir = Path(args.labels_dir).resolve()
    refs_dir = Path(args.refs_dir).resolve() if args.refs_dir else labels_dir
    split_file = Path(args.split_file).resolve() if args.split_file else None

    print(f"\n{'=' * 60}")
    print(f"  OCR EVALUATION")
    print(f"  Predictions : {labels_dir}")
    print(f"  References  : {refs_dir}")
    print(f"{'=' * 60}\n")

    # Optionally filter to a split (file listing image stems, one per line)
    allowed_stems: set[str] | None = None
    if split_file and split_file.exists():
        allowed_stems = set(split_file.read_text().strip().splitlines())
        print(f"[info] Filtering to {len(allowed_stems)} images from {split_file}")

    pred_jsons = sorted(labels_dir.glob("*.json"))
    if not pred_jsons:
        print(f"[error] No JSON files found in {labels_dir}")
        sys.exit(1)

    cer_values: list[float] = []
    wer_values: list[float] = []
    per_image: list[dict] = []

    for pred_json in tqdm(pred_jsons, desc="OCR eval"):
        stem = pred_json.stem
        if allowed_stems is not None and stem not in allowed_stems:
            continue

        with open(pred_json, "r", encoding="utf-8") as f:
            pred_doc = json.load(f)

        # Load reference: either from refs_dir (corrected copy) or same file
        ref_json_path = refs_dir / pred_json.name
        if ref_json_path.exists() and refs_dir != labels_dir:
            with open(ref_json_path, "r", encoding="utf-8") as f:
                ref_doc = json.load(f)
        else:
            ref_doc = pred_doc

        # Build reference lookup by region id
        ref_by_id: dict[str, str] = {}
        for region in ref_doc.get("regions", []):
            rid = region.get("id", "")
            # Prefer corrected text, fall back to ocr_text
            ref_text = region.get("ocr_text_corrected", "")
            if not ref_text:
                ref_text = region.get("reference_text", "")
            if ref_text:
                ref_by_id[rid] = ref_text

        if not ref_by_id:
            continue

        img_cer: list[float] = []
        img_wer: list[float] = []

        for region in pred_doc.get("regions", []):
            rid = region.get("id", "")
            if rid not in ref_by_id:
                continue
            pred_text = region.get("ocr_text", "")
            ref_text = ref_by_id[rid]
            c = char_error_rate(ref_text, pred_text)
            w = word_error_rate(ref_text, pred_text)
            cer_values.append(c)
            wer_values.append(w)
            img_cer.append(c)
            img_wer.append(w)

        if img_cer:
            per_image.append({
                "image": stem,
                "mean_cer": round(float(np.mean(img_cer)), 5),
                "mean_wer": round(float(np.mean(img_wer)), 5),
                "n_regions": len(img_cer),
            })

    if not cer_values:
        print("[warn] No reference texts found. Make sure JSON files contain")
        print("  'ocr_text_corrected' or 'reference_text' fields.")
        return

    mean_cer = float(np.mean(cer_values))
    mean_wer = float(np.mean(wer_values))
    median_cer = float(np.median(cer_values))
    median_wer = float(np.median(wer_values))

    print("\n--- OCR Evaluation Results ---")
    headers = ["Metric", "Mean", "Median", "N regions"]
    rows = [
        ["CER", f"{mean_cer:.4f}", f"{median_cer:.4f}", str(len(cer_values))],
        ["WER", f"{mean_wer:.4f}", f"{median_wer:.4f}", str(len(wer_values))],
    ]
    _print_table(headers, rows)

    # Per-image breakdown (worst first)
    per_image.sort(key=lambda x: x["mean_cer"], reverse=True)
    print("\n--- Worst 10 images by CER ---")
    headers_img = ["Image", "CER", "WER", "Regions"]
    rows_img = [
        [p["image"], f"{p['mean_cer']:.4f}", f"{p['mean_wer']:.4f}", str(p["n_regions"])]
        for p in per_image[:10]
    ]
    _print_table(headers_img, rows_img)

    report = {
        "mean_cer": round(mean_cer, 5),
        "mean_wer": round(mean_wer, 5),
        "median_cer": round(median_cer, 5),
        "median_wer": round(median_wer, 5),
        "n_regions": len(cer_values),
        "n_images": len(per_image),
        "per_image": per_image,
    }
    _save_report(report, Path(args.report_out))


# ===================================================================
# SUBCOMMAND: translate-eval
# ===================================================================

def cmd_translate_eval(args: argparse.Namespace) -> None:
    """Evaluate translation quality against reference translations (BLEU, chrF).

    Expects a JSON file with structure:
    [
      {"source": "...", "hypothesis": "...", "reference": "..."},
      ...
    ]
    """
    refs_file = Path(args.refs_file).resolve()

    print(f"\n{'=' * 60}")
    print(f"  TRANSLATION EVALUATION")
    print(f"  References : {refs_file}")
    print(f"{'=' * 60}\n")

    with open(refs_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not data:
        print("[error] Empty references file.")
        sys.exit(1)

    hypotheses: list[str] = []
    references: list[str] = []
    for item in data:
        hyp = item.get("hypothesis", item.get("translated", "")).strip()
        ref = item.get("reference", item.get("reference_text", "")).strip()
        if not ref:
            continue
        hypotheses.append(hyp)
        references.append(ref)

    if not references:
        print("[error] No reference translations found.")
        sys.exit(1)

    # BLEU via sacrebleu
    bleu_score = None
    chrf_score = None
    try:
        import sacrebleu
        bleu_result = sacrebleu.corpus_bleu(hypotheses, [references])
        bleu_score = round(bleu_result.score, 3)
        chrf_result = sacrebleu.corpus_chrf(hypotheses, [references])
        chrf_score = round(chrf_result.score, 3)
    except ImportError:
        print("[warn] sacrebleu not installed. Install with: pip install sacrebleu")
        print("  Falling back to simple BLEU approximation.")
        # Rough 1-gram precision as fallback
        correct = sum(1 for h, r in zip(hypotheses, references) if h == r)
        bleu_score = round(correct / max(len(references), 1) * 100, 3)

    print("\n--- Translation Evaluation Results ---")
    headers = ["Metric", "Score", "N pairs"]
    rows = []
    if bleu_score is not None:
        rows.append(["BLEU", f"{bleu_score:.2f}", str(len(references))])
    if chrf_score is not None:
        rows.append(["chrF", f"{chrf_score:.2f}", str(len(references))])
    _print_table(headers, rows)

    report = {
        "bleu": bleu_score,
        "chrf": chrf_score,
        "n_pairs": len(references),
    }
    _save_report(report, Path(args.report_out))


# ===================================================================
# SUBCOMMAND: full-benchmark
# ===================================================================

def cmd_full_benchmark(args: argparse.Namespace) -> None:
    """Run the full pipeline on a set of images.

    Measures time per stage (segmentation, OCR, translation, inpainting)
    and total time. Outputs a summary table and JSON report.
    """
    from tqdm import tqdm

    images_dir = Path(args.images_dir).resolve()
    model_path = Path(args.model_path).resolve()
    target_lang = args.target_lang
    imgsz = args.imgsz
    conf = args.conf
    iou_thresh = args.iou
    skip_inpaint = args.skip_inpaint
    skip_translate = args.skip_translate

    images = list_images(images_dir)
    if not images:
        print(f"[error] No images found in {images_dir}")
        sys.exit(1)

    print(f"\n{'=' * 60}")
    print(f"  FULL PIPELINE BENCHMARK")
    print(f"  Images    : {images_dir} ({len(images)} files)")
    print(f"  Model     : {model_path}")
    print(f"  Target    : {target_lang}")
    print(f"  Inpaint   : {'skip' if skip_inpaint else 'yes'}")
    print(f"  Translate : {'skip' if skip_translate else 'yes'}")
    print(f"{'=' * 60}\n")

    # Pre-load all models
    yolo = get_yolo(str(model_path))
    mocr = get_manga_ocr()
    lama = None if skip_inpaint else get_lama()

    per_image_results: list[dict] = []
    stage_totals = {
        "segmentation": 0.0,
        "ocr": 0.0,
        "translation": 0.0,
        "inpainting": 0.0,
        "total": 0.0,
    }

    YOLO_CLASS_MAP: dict[str, str] = {
        "bubble_text": "bubble",
        "nonbubble_text": "text",
        "sfx": "text",
        "bubble": "bubble",
        "buble": "bubble",
        "text": "text",
    }

    for img_path in tqdm(images, desc="Benchmark"):
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]
        file_bytes = img_path.read_bytes()
        timings: dict[str, float] = {}
        t_total_start = time.perf_counter()

        # ---- Stage 1: Segmentation ----
        t0 = time.perf_counter()
        results = list(yolo.predict(
            source=img,
            imgsz=imgsz,
            conf=conf,
            iou=iou_thresh,
            retina_masks=True,
            verbose=False,
            stream=True,
        ))
        timings["segmentation"] = time.perf_counter() - t0

        detections: list[dict] = []
        if results and results[0].boxes is not None and len(results[0].boxes) > 0:
            res = results[0]
            model_names = res.names or {}
            for idx in range(len(res.boxes)):
                box = res.boxes[idx]
                cls_id = int(box.cls[0].item())
                cls_name = model_names.get(cls_id, str(cls_id)).lower()
                label = YOLO_CLASS_MAP.get(cls_name, "text")
                x1, y1, x2, y2 = [int(c) for c in box.xyxy[0].tolist()]
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, x2), min(h, y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                detections.append({
                    "id": f"r-{idx + 1}",
                    "bbox": [x1, y1, x2, y2],
                    "label": label,
                    "class_name": cls_name,
                    "confidence": float(box.conf[0].item()),
                })

        # ---- Stage 2: OCR ----
        t0 = time.perf_counter()
        ocr_texts: list[str] = []
        for det in detections:
            x1, y1, x2, y2 = det["bbox"]
            crop = img[y1:y2, x1:x2]
            if crop.size == 0:
                ocr_texts.append("")
                continue
            try:
                crop_pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
                text = mocr(crop_pil).strip()
                ocr_texts.append(text)
            except Exception:
                ocr_texts.append("")
        timings["ocr"] = time.perf_counter() - t0

        # ---- Stage 3: Translation ----
        translated_texts: list[str] = []
        if skip_translate:
            timings["translation"] = 0.0
            translated_texts = [""] * len(ocr_texts)
        else:
            t0 = time.perf_counter()
            non_empty = [(i, t) for i, t in enumerate(ocr_texts) if t.strip()]
            translated_texts = [""] * len(ocr_texts)
            if non_empty:
                try:
                    from app.services.providers import _translate_via_openrouter
                    source_texts = [t for _, t in non_empty]
                    translated = _translate_via_openrouter(source_texts, target_lang)
                    for k, (orig_idx, _) in enumerate(non_empty):
                        if k < len(translated):
                            translated_texts[orig_idx] = translated[k]
                except Exception as exc:
                    print(f"  [warn] Translation failed: {exc}")
            timings["translation"] = time.perf_counter() - t0

        # ---- Stage 4: Inpainting ----
        if skip_inpaint or not detections:
            timings["inpainting"] = 0.0
        else:
            t0 = time.perf_counter()
            try:
                pil_img = Image.open(str(img_path)).convert("RGB")
                from PIL import ImageDraw
                mask = Image.new("L", (w, h), 0)
                draw = ImageDraw.Draw(mask)
                for det in detections:
                    x1, y1, x2, y2 = det["bbox"]
                    draw.rectangle([x1, y1, x2, y2], fill=255)
                _result = lama(pil_img, mask)
            except Exception as exc:
                print(f"  [warn] Inpainting failed: {exc}")
            timings["inpainting"] = time.perf_counter() - t0

        timings["total"] = time.perf_counter() - t_total_start

        for stage_key in stage_totals:
            stage_totals[stage_key] += timings.get(stage_key, 0.0)

        per_image_results.append({
            "image": img_path.name,
            "n_detections": len(detections),
            "n_ocr_non_empty": sum(1 for t in ocr_texts if t.strip()),
            "timings_sec": {k: round(v, 4) for k, v in timings.items()},
        })

    # ---- Summary ----
    n_images = len(per_image_results)
    if n_images == 0:
        print("[warn] No images processed.")
        return

    print(f"\n--- Full Pipeline Benchmark ({n_images} images) ---")
    headers = ["Stage", "Total (s)", "Mean (s)", "% of total"]
    rows = []
    total_time = stage_totals["total"]
    for stage in ("segmentation", "ocr", "translation", "inpainting"):
        t = stage_totals[stage]
        pct = (t / total_time * 100) if total_time > 0 else 0
        rows.append([
            stage.capitalize(),
            f"{t:.3f}",
            f"{t / n_images:.3f}",
            f"{pct:.1f}%",
        ])
    rows.append([
        "TOTAL",
        f"{total_time:.3f}",
        f"{total_time / n_images:.3f}",
        "100.0%",
    ])
    _print_table(headers, rows)

    total_dets = sum(r["n_detections"] for r in per_image_results)
    total_ocr = sum(r["n_ocr_non_empty"] for r in per_image_results)
    print(f"\n  Total detections  : {total_dets}")
    print(f"  Total OCR non-empty: {total_ocr}")
    print(f"  Images/sec        : {n_images / total_time:.2f}" if total_time > 0 else "")

    report = {
        "n_images": n_images,
        "total_detections": total_dets,
        "total_ocr_non_empty": total_ocr,
        "stage_totals_sec": {k: round(v, 4) for k, v in stage_totals.items()},
        "stage_means_sec": {k: round(v / n_images, 4) for k, v in stage_totals.items()},
        "images_per_sec": round(n_images / total_time, 3) if total_time > 0 else 0,
        "per_image": per_image_results,
    }
    _save_report(report, Path(args.report_out))


# ===================================================================
# CLI entrypoint
# ===================================================================

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manga translation pipeline evaluation and benchmark tool.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ---------- segment-eval ----------
    p_seg = sub.add_parser("segment-eval", help="Evaluate YOLO segmentation quality")
    p_seg.add_argument("--data-yaml", required=True, help="Path to YOLO data.yaml")
    p_seg.add_argument("--model-path", required=True, help="Path to YOLO .pt weights")
    p_seg.add_argument("--split", default="val", choices=["val", "test"], help="Dataset split")
    p_seg.add_argument("--imgsz", type=int, default=1024, help="Inference image size")
    p_seg.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    p_seg.add_argument("--iou", type=float, default=0.5, help="IoU threshold for NMS")
    p_seg.add_argument("--report-out", default="scripts/reports/segment_eval.json", help="Output report path")
    p_seg.set_defaults(func=cmd_segment_eval)

    # ---------- ocr-label ----------
    p_ocr_label = sub.add_parser("ocr-label", help="Run MangaOCR on regions and export editable labels")
    p_ocr_label.add_argument("--images-dir", required=True, help="Directory with input images")
    p_ocr_label.add_argument("--model-path", required=True, help="Path to YOLO .pt weights")
    p_ocr_label.add_argument("--output-dir", default="scripts/ocr_labels", help="Output directory for JSON labels")
    p_ocr_label.add_argument("--labels-dir", default=None, help="Path to GT label .txt files (YOLO format). If given, use GT polygons instead of predictions.")
    p_ocr_label.add_argument("--data-yaml", default=None, help="Path to data.yaml (for class names)")
    p_ocr_label.add_argument("--imgsz", type=int, default=1024, help="Inference image size")
    p_ocr_label.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    p_ocr_label.add_argument("--iou", type=float, default=0.5, help="IoU threshold")
    p_ocr_label.set_defaults(func=cmd_ocr_label)

    # ---------- ocr-eval ----------
    p_ocr_eval = sub.add_parser("ocr-eval", help="Evaluate OCR quality against corrected labels")
    p_ocr_eval.add_argument("--labels-dir", required=True, help="Dir with prediction JSON files (from ocr-label)")
    p_ocr_eval.add_argument("--refs-dir", default=None, help="Dir with corrected JSON files. If omitted, looks for 'ocr_text_corrected' field in --labels-dir.")
    p_ocr_eval.add_argument("--split-file", default=None, help="Text file with image stems (one per line) to restrict evaluation to a subset.")
    p_ocr_eval.add_argument("--report-out", default="scripts/reports/ocr_eval.json", help="Output report path")
    p_ocr_eval.set_defaults(func=cmd_ocr_eval)

    # ---------- translate-eval ----------
    p_trans = sub.add_parser("translate-eval", help="Evaluate translation quality (BLEU, chrF)")
    p_trans.add_argument("--refs-file", required=True, help="JSON file with source/hypothesis/reference triples")
    p_trans.add_argument("--report-out", default="scripts/reports/translate_eval.json", help="Output report path")
    p_trans.set_defaults(func=cmd_translate_eval)

    # ---------- full-benchmark ----------
    p_bench = sub.add_parser("full-benchmark", help="Run full pipeline and measure stage timings")
    p_bench.add_argument("--images-dir", required=True, help="Directory with input images")
    p_bench.add_argument("--model-path", required=True, help="Path to YOLO .pt weights")
    p_bench.add_argument("--target-lang", default="ru", help="Target language code")
    p_bench.add_argument("--imgsz", type=int, default=1024, help="Inference image size")
    p_bench.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    p_bench.add_argument("--iou", type=float, default=0.5, help="IoU threshold")
    p_bench.add_argument("--skip-inpaint", action="store_true", help="Skip inpainting stage")
    p_bench.add_argument("--skip-translate", action="store_true", help="Skip translation stage (requires API key)")
    p_bench.add_argument("--report-out", default="scripts/reports/full_benchmark.json", help="Output report path")
    p_bench.set_defaults(func=cmd_full_benchmark)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
