"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelPipelineJob,
  createPipelineJob,
  exportProjectZip,
  fetchProjectProgress,
  fetchProviders,
  fetchPageRegions,
  fetchPipelineJob,
  fetchLastSession,
  fetchPageInput,
  fetchPagePreview,
  issueDevToken,
  patchRegion,
  previewInpaint,
  previewMask,
  upsertLastSession,
  translateTexts
} from "@/lib/api";
import { DetectedRegion, MaskRegion, PipelineConfig, ProjectProgress, ProviderInfo, Point } from "@/lib/types";

type ReviewStatus = "todo" | "edited" | "approved";
type FilterMode = "all" | "todo" | "edited" | "approved" | "low_confidence" | "empty";
type PanelId = "workflow" | "text";
type ToolMode = "select" | "pan" | "zoom";

type EditorRegion = DetectedRegion & {
  review_status: ReviewStatus;
  note: string;
  font_family: string;
  font_size: number;
  font_style: "normal" | "italic";
  font_weight: "400" | "600" | "700";
  text_color: string;
  text_opacity: number;
  outline_enabled: boolean;
  outline_color: string;
  outline_width: number;
  background_color: string;
  background_opacity: number;
  background_blur: number;
};

type ImageMeta = {
  width: number;
  height: number;
};

type PageDoc = {
  id: string;
  file: File;
  file_name: string;
  original_preview: string;
  preview: string;
  processed_preview: string | null;
  image_meta: ImageMeta;
  regions: EditorRegion[];
  mask_regions: MaskRegion[];
  project_id: string | null;
  server_page_id: string | null;
  region_id_map: Record<string, string>;
  selected_region_id: string | null;
  selected_mask_region_id: string | null;
  latest_job_id: string | null;
  pipeline_status: "idle" | "running" | "done" | "error";
  pipeline_error: string | null;
};

type ExportOptions = {
  scope: "current" | "all";
  export_json: boolean;
  export_png: boolean;
  export_project: boolean;
  include_styles: boolean;
  prefix: string;
};

type PanelState = {
  x: number;
  y: number;
  width: number;
  collapsed: boolean;
};

type PanelDragState = {
  id: PanelId;
  side: "left" | "right";
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

type RegionDragState = {
  kind: "text" | "mask";
  mode: "move" | "resize";
  id: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  startPolygon: Point[] | null;
  displayWidth: number;
  displayHeight: number;
};

type PanDragState = {
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

type MaskControls = {
  inpaintBubbleExpandPx: number;
  inpaintTextExpandPx: number;
  inpaintBubbleScale: number;
  inpaintTextScale: number;
};

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scope: "all",
  export_json: true,
  export_png: true,
  export_project: true,
  include_styles: true,
  prefix: "mangaflow"
};
const PIPELINE_POLL_MAX_ATTEMPTS = 600;
const PIPELINE_POLL_INTERVAL_MS = 1000;
const DEFAULT_MASK_CONTROLS: MaskControls = {
  inpaintBubbleExpandPx: 8,
  inpaintTextExpandPx: 3,
  inpaintBubbleScale: 1.03,
  inpaintTextScale: 1
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace("#", "");
  const normalized =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;

  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return text ? [text] : [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    fontFamily: string;
    fontStyle: "normal" | "italic";
    fontWeight: "400" | "600" | "700";
    preferredSize: number;
    outlineEnabled: boolean;
    outlineColor: string;
    outlineWidth: number;
  }
) {
  const { x, y, width, height, fontFamily, fontStyle, fontWeight, preferredSize, outlineEnabled, outlineColor, outlineWidth } = opts;
  if (!text.trim()) return;
  const padding = 6;
  const maxWidth = Math.max(8, width - padding * 2);
  const maxHeight = Math.max(8, height - padding * 2);
  let size = Math.max(10, Math.round(preferredSize));
  let chosenLines: string[] = [text];

  while (size >= 10) {
    ctx.font = `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`;
    const lines = wrapTextLines(ctx, text, maxWidth);
    const lineHeight = Math.max(12, Math.round(size * 1.16));
    if (lines.length * lineHeight <= maxHeight) {
      chosenLines = lines;
      break;
    }
    size -= 1;
  }

  ctx.font = `${fontStyle} ${fontWeight} ${Math.max(10, size)}px ${fontFamily}`;
  const lineHeight = Math.max(12, Math.round(Math.max(10, size) * 1.16));
  chosenLines.forEach((line, idx) => {
    const lineX = x + padding;
    const lineY = y + padding + idx * lineHeight;
    if (outlineEnabled && outlineWidth > 0) {
      ctx.strokeStyle = outlineColor;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(1, outlineWidth);
      ctx.strokeText(line, lineX, lineY, maxWidth);
    }
    ctx.fillText(line, lineX, lineY, maxWidth);
  });
}

function resolveProvider(engine: string): "stub" | "huggingface" | "custom" {
  if (engine === "huggingface") return "huggingface";
  if (engine === "custom") return "custom";
  return "stub";
}

function clampPercent(value: number) {
  return clamp(value, 0, 100);
}

function normalizePolygon(polygon: Point[] | null | undefined): Point[] | null {
  if (!polygon || polygon.length < 3) return null;
  return polygon.map((pt) => ({
    x: Number(clampPercent(pt.x).toFixed(4)),
    y: Number(clampPercent(pt.y).toFixed(4))
  }));
}

function transformPolygonByBox(polygon: Point[] | null, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }): Point[] | null {
  if (!polygon || polygon.length < 3) return null;
  const fromW = Math.max(0.0001, from.width);
  const fromH = Math.max(0.0001, from.height);
  return normalizePolygon(
    polygon.map((pt) => {
      const rx = (pt.x - from.x) / fromW;
      const ry = (pt.y - from.y) / fromH;
      return {
        x: to.x + rx * to.width,
        y: to.y + ry * to.height
      };
    })
  );
}

function toEditorRegion(region: DetectedRegion): EditorRegion {
  return {
    ...region,
    review_status: region.translated_text?.trim() ? "edited" : "todo",
    note: "",
    font_family: "Arial",
    font_size: 24,
    font_style: "normal",
    font_weight: "600",
    text_color: "#000000",
    text_opacity: 1,
    outline_enabled: true,
    outline_color: "#ffffff",
    outline_width: 2,
    background_color: "#ffffff",
    background_opacity: 0,
    background_blur: 0
  };
}

async function fileToDataURL(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function imageMetaFromDataURL(dataUrl: string): Promise<ImageMeta> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function renderPageToPng(page: PageDoc): Promise<string> {
  const image = new Image();
  image.src = page.preview;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = page.image_meta.width;
  canvas.height = page.image_meta.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.drawImage(image, 0, 0);

  for (const region of page.regions) {
    const x = (region.x / 100) * canvas.width;
    const y = (region.y / 100) * canvas.height;
    const w = (region.width / 100) * canvas.width;
    const h = (region.height / 100) * canvas.height;

    if (region.background_opacity > 0) {
      ctx.fillStyle = hexToRgba(region.background_color, region.background_opacity);
      ctx.fillRect(x, y, w, h);
    }

    ctx.fillStyle = hexToRgba(region.text_color, region.text_opacity);
    ctx.textBaseline = "top";
    drawFittedText(ctx, region.translated_text || region.source_text || "", {
      x,
      y,
      width: w,
      height: h,
      fontFamily: region.font_family,
      fontStyle: region.font_style,
      fontWeight: region.font_weight,
      preferredSize: region.font_size,
      outlineEnabled: region.outline_enabled,
      outlineColor: region.outline_color,
      outlineWidth: region.outline_width
    });
  }

  return canvas.toDataURL("image/png");
}

function downloadBlob(content: Blob, filename: string) {
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function statusColor(status: ReviewStatus): string {
  if (status === "approved") return "#22c55e";
  if (status === "edited") return "#38bdf8";
  return "#ff9d42";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function EditorWorkbench() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const saveTimersRef = useRef<Record<string, number>>({});

  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [pages, setPages] = useState<PageDoc[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);

  const [targetLang, setTargetLang] = useState("ru");
  const [sourceLang, setSourceLang] = useState("ja");
  const [translatorEngine, setTranslatorEngine] = useState("custom");
  const [pipelineConfig, setPipelineConfig] = useState<PipelineConfig>({
    detector: { provider: "custom", model: "default", version: "v1", params: {} },
    inpainter: { provider: "custom", model: "default", version: "v1", params: {} },
    ocr: { provider: "custom", model: "default", version: "v1", params: {} },
    translator: { provider: "custom", model: "default", version: "v1", params: {} }
  });
  const [providerCatalog, setProviderCatalog] = useState<ProviderInfo[]>([]);
  const [projectProgress, setProjectProgress] = useState<ProjectProgress | null>(null);
  const [draftSourceText, setDraftSourceText] = useState("");
  const [draftTranslatedText, setDraftTranslatedText] = useState("");
  const [smartFillEnabled, setSmartFillEnabled] = useState(true);
  const [maskControls, setMaskControls] = useState<MaskControls>(DEFAULT_MASK_CONTROLS);
  const [showMaskPreview, setShowMaskPreview] = useState(false);
  const [maskPreviewLoading, setMaskPreviewLoading] = useState(false);
  const [inpaintLoading, setInpaintLoading] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [maskPreviewError, setMaskPreviewError] = useState<string | null>(null);
  const [showOriginalImage, setShowOriginalImage] = useState(false);

  const [showRegions, setShowRegions] = useState(true);
  const [showText, setShowText] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchText, setSearchText] = useState("");
  const [zoomPercent, setZoomPercent] = useState(140);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [isSpacePanning, setIsSpacePanning] = useState(false);

  const [panelDrag, setPanelDrag] = useState<PanelDragState | null>(null);
  const [regionDrag, setRegionDrag] = useState<RegionDragState | null>(null);
  const [panDrag, setPanDrag] = useState<PanDragState | null>(null);
  const [panels, setPanels] = useState<Record<PanelId, PanelState>>({
    workflow: { x: 14, y: 14, width: 340, collapsed: false },
    text: { x: 14, y: 14, width: 380, collapsed: false }
  });

  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [notice, setNotice] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const currentPage = pages[activePageIndex] ?? null;
  const effectiveToolMode: ToolMode = isSpacePanning ? "pan" : toolMode;
  const displayImageSrc = currentPage
    ? showOriginalImage || !currentPage.processed_preview
      ? currentPage.original_preview
      : currentPage.preview
    : "";

  useEffect(() => {
    let cancelled = false;
    const initToken = async () => {
      try {
        const storageKey = "mangaflow_dev_user_id";
        const existing = window.localStorage.getItem(storageKey);
        const userId = existing || `dev-user-${Math.random().toString(36).slice(2, 10)}`;
        if (!existing) window.localStorage.setItem(storageKey, userId);
        let attempt = 0;
        while (!cancelled) {
          try {
            const token = await issueDevToken(userId);
            if (!cancelled) {
              setAuthToken(token);
              setNotice(null);
            }
            return;
          } catch {
            attempt += 1;
            if (!cancelled && attempt === 5) {
              setNotice("JWT dev-token временно недоступен. Пробуем переподключиться...");
            }
            await sleep(Math.min(5_000, 600 + attempt * 500));
          }
        }
      } catch {
        if (!cancelled) setNotice("JWT dev-token недоступен. Пробуем переподключиться...");
      }
    };
    void initToken();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadProviders = async () => {
      try {
        const providers = await fetchProviders();
        if (cancelled) return;
        setProviderCatalog(providers);
      } catch {
        // Keep editor usable with defaults.
      }
    };
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authToken || restored) return;
    if (pages.length > 0) {
      setRestored(true);
      return;
    }

    const restore = async () => {
      let session: { project_id?: string | null; page_id?: string | null; file_name?: string | null; view_params?: Record<string, unknown> } = {};
      try {
        session = await fetchLastSession(authToken);
        if (!session.project_id || !session.page_id) {
          const raw = window.localStorage.getItem("mangaflow_last_session");
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as { project_id?: string; page_id?: string; file_name?: string };
              session = parsed;
            } catch {
              window.localStorage.removeItem("mangaflow_last_session");
            }
          }
        }
        if (!session.project_id || !session.page_id) {
          setRestored(true);
          return;
        }

        const inputBlob = await fetchPageInput(
          { projectId: session.project_id as string, pageId: session.page_id as string },
          authToken
        );
        let previewBlob: Blob = inputBlob;
        try {
          previewBlob = await fetchPagePreview(
            { projectId: session.project_id as string, pageId: session.page_id as string },
            authToken
          );
        } catch {
          // Fallback to original input when preview artifact is not ready yet.
        }

        const fileName = session.file_name || "restored.png";
        const file = new File([inputBlob], fileName, { type: inputBlob.type || "image/png" });
        const originalPreview = await fileToDataURL(file);
        const previewFile = new File([previewBlob], `preview-${fileName}`, { type: previewBlob.type || "image/png" });
        const preview = await fileToDataURL(previewFile);
        const image_meta = await imageMetaFromDataURL(preview);
        const serverRegions = await fetchPageRegions(
          { projectId: session.project_id as string, pageId: session.page_id as string },
          authToken
        );

        const mapped = serverRegions.map((region) =>
          toEditorRegion({
            id: region.external_region_id,
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            source_text: region.source_text,
            translated_text: region.translated_text,
            confidence: region.confidence
          })
        );

        const regionMap = serverRegions.reduce<Record<string, string>>((acc, region) => {
          acc[region.external_region_id] = region.id;
          return acc;
        }, {});

        setPages([
          {
            id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            file_name: file.name,
            original_preview: originalPreview,
            preview,
            processed_preview: preview !== originalPreview ? preview : null,
            image_meta,
            regions: mapped,
            mask_regions: [],
            project_id: session.project_id as string,
            server_page_id: session.page_id as string,
            region_id_map: regionMap,
            selected_region_id: mapped[0]?.id ?? null,
            selected_mask_region_id: null,
            latest_job_id: null,
            pipeline_status: "done",
            pipeline_error: null
          }
        ]);
        setActivePageIndex(0);
        setDraftSourceText(mapped[0]?.source_text ?? "");
        setDraftTranslatedText(mapped[0]?.translated_text ?? "");
        const view = (session.view_params || {}) as Record<string, unknown>;
        const zoom = Number(view.zoom_percent ?? NaN);
        if (Number.isFinite(zoom)) setZoomPercent(clamp(zoom, 40, 600));
        const panX = Number(view.pan_x ?? NaN);
        const panY = Number(view.pan_y ?? NaN);
        if (Number.isFinite(panX) && Number.isFinite(panY)) setPanOffset({ x: panX, y: panY });
        if (typeof view.show_original === "boolean") setShowOriginalImage(Boolean(view.show_original));
        setNotice("Сессия восстановлена из сервера.");
      } catch (error) {
        setNotice("Не удалось восстановить последнюю сессию.");
      } finally {
        setRestored(true);
      }
    };

    void restore();
  }, [authToken, restored, pages.length]);

  const quality = useMemo(() => {
    if (!currentPage) return { total: 0, approved: 0, progress: 0 };
    const total = currentPage.regions.length;
    const approved = currentPage.regions.filter((r) => r.review_status === "approved").length;
    const progress = total ? Math.round((approved / total) * 100) : 0;
    return { total, approved, progress };
  }, [currentPage]);

  const selectedRegion = useMemo(() => {
    if (!currentPage) return null;
    return currentPage.regions.find((region) => region.id === currentPage.selected_region_id) ?? null;
  }, [currentPage]);

  const selectedMaskRegion = useMemo(() => {
    if (!currentPage) return null;
    return currentPage.mask_regions.find((region) => region.id === currentPage.selected_mask_region_id) ?? null;
  }, [currentPage]);

  useEffect(() => {
    if (!selectedRegion) return;
    setDraftSourceText(selectedRegion.source_text);
    setDraftTranslatedText(selectedRegion.translated_text);
  }, [selectedRegion?.id]);

  const filteredRegions = useMemo(() => {
    if (!currentPage) return [];
    const query = searchText.trim().toLowerCase();

    return currentPage.regions.filter((region) => {
      if (filterMode === "todo" && region.review_status !== "todo") return false;
      if (filterMode === "edited" && region.review_status !== "edited") return false;
      if (filterMode === "approved" && region.review_status !== "approved") return false;
      if (filterMode === "low_confidence" && region.confidence >= 0.9) return false;
      if (filterMode === "empty" && region.translated_text.trim()) return false;

      if (!query) return true;
      const haystack = `${region.id} ${region.source_text} ${region.translated_text} ${region.note}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [currentPage, filterMode, searchText]);

  const displayedRect = useMemo(() => {
    if (!currentPage) {
      return { width: 1, height: 1, x: 0, y: 0, scale: 1 };
    }

    const pad = 8;
    const maxW = Math.max(100, stageSize.width - pad * 2);
    const maxH = Math.max(100, stageSize.height - pad * 2);
    const fitScale = Math.min(maxW / currentPage.image_meta.width, maxH / currentPage.image_meta.height);
    const scale = fitScale * (zoomPercent / 100);

    const width = Math.round(currentPage.image_meta.width * scale);
    const height = Math.round(currentPage.image_meta.height * scale);

    return {
      width,
      height,
      x: Math.round((stageSize.width - width) / 2),
      y: Math.round((stageSize.height - height) / 2),
      scale
    };
  }, [currentPage, stageSize, zoomPercent]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;

    const syncSize = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      setStageSize({ width, height });
    };

    syncSize();

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(element);

    window.addEventListener("resize", syncSize);
    const raf = requestAnimationFrame(syncSize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", syncSize);
      observer.disconnect();
    };
  }, [currentPage?.id]);

  useEffect(() => {
    if (!stageSize.width || !stageSize.height) return;
    setPanels((current) => {
      const next = { ...current };
      (Object.keys(next) as PanelId[]).forEach((id) => {
        const panel = next[id];
        const maxX = Math.max(8, stageSize.width - panel.width - 8);
        const maxY = Math.max(8, stageSize.height - (panel.collapsed ? 44 : 260));
        next[id] = {
          ...panel,
          x: clamp(panel.x, 8, maxX),
          y: clamp(panel.y, 8, maxY)
        };
      });
      return next;
    });
  }, [stageSize.width, stageSize.height]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (panelDrag && stageRef.current) {
        const dx = event.clientX - panelDrag.startClientX;
        const dy = event.clientY - panelDrag.startClientY;

        setPanels((current) => {
          const panel = current[panelDrag.id];
          const stageW = stageRef.current?.clientWidth ?? 0;
          const stageH = stageRef.current?.clientHeight ?? 0;

          const nextX = panelDrag.side === "left"
            ? clamp(panelDrag.startX + dx, 8, Math.max(8, stageW - panel.width - 8))
            : clamp(panelDrag.startX - dx, 8, Math.max(8, stageW - panel.width - 8));
          const nextY = clamp(panelDrag.startY + dy, 8, Math.max(8, stageH - (panel.collapsed ? 44 : 260)));

          return { ...current, [panelDrag.id]: { ...panel, x: nextX, y: nextY } };
        });
      }

      if (regionDrag && currentPage && effectiveToolMode === "select") {
        const dx = event.clientX - regionDrag.startClientX;
        const dy = event.clientY - regionDrag.startClientY;

        const dxPercent = (dx / regionDrag.displayWidth) * 100;
        const dyPercent = (dy / regionDrag.displayHeight) * 100;

        setPages((current) =>
          current.map((page, idx) => {
            if (idx !== activePageIndex) return page;
            if (regionDrag.kind === "text") {
              return {
                ...page,
                regions: page.regions.map((region) => {
                  if (region.id !== regionDrag.id) return region;
                  if (regionDrag.mode === "move") {
                    const x = clamp(regionDrag.startX + dxPercent, 0, 100 - region.width);
                    const y = clamp(regionDrag.startY + dyPercent, 0, 100 - region.height);
                    return { ...region, x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
                  }
                  const minW = 1;
                  const minH = 1;
                  const width = clamp(regionDrag.startWidth + dxPercent, minW, 100 - region.x);
                  const height = clamp(regionDrag.startHeight + dyPercent, minH, 100 - region.y);
                  return { ...region, width: Number(width.toFixed(3)), height: Number(height.toFixed(3)) };
                })
              };
            }

            return {
              ...page,
              mask_regions: page.mask_regions.map((region) => {
                if (region.id !== regionDrag.id) return region;
                let nextX = region.x;
                let nextY = region.y;
                let nextW = region.width;
                let nextH = region.height;
                if (regionDrag.mode === "move") {
                  nextX = clamp(regionDrag.startX + dxPercent, 0, 100 - region.width);
                  nextY = clamp(regionDrag.startY + dyPercent, 0, 100 - region.height);
                } else {
                  nextW = clamp(regionDrag.startWidth + dxPercent, 1, 100 - region.x);
                  nextH = clamp(regionDrag.startHeight + dyPercent, 1, 100 - region.y);
                }
                const nextRegion: MaskRegion = {
                  ...region,
                  x: Number(nextX.toFixed(3)),
                  y: Number(nextY.toFixed(3)),
                  width: Number(nextW.toFixed(3)),
                  height: Number(nextH.toFixed(3))
                };
                const transformed = transformPolygonByBox(
                  regionDrag.startPolygon,
                  {
                    x: regionDrag.startX,
                    y: regionDrag.startY,
                    width: regionDrag.startWidth,
                    height: regionDrag.startHeight
                  },
                  { x: nextRegion.x, y: nextRegion.y, width: nextRegion.width, height: nextRegion.height }
                );
                if (transformed) nextRegion.polygon = transformed;
                return nextRegion;
              })
            };
          })
        );
      }

      if (panDrag && effectiveToolMode === "pan") {
        const dx = event.clientX - panDrag.startClientX;
        const dy = event.clientY - panDrag.startClientY;
        setPanOffset({
          x: panDrag.startX + dx,
          y: panDrag.startY + dy
        });
      }
    };

    const onMouseUp = () => {
      if (regionDrag && currentPage && regionDrag.kind === "text") {
        const region = currentPage.regions.find((item) => item.id === regionDrag.id);
        if (region) {
          scheduleRegionAutosave(currentPage, region.id, {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height
          });
        }
      }
      setPanelDrag(null);
      setRegionDrag(null);
      setPanDrag(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [panelDrag, regionDrag, panDrag, currentPage, activePageIndex, effectiveToolMode, authToken]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTypingTarget(event.target)) {
        if (event.code === "Space") {
          event.preventDefault();
          setIsSpacePanning(true);
        }
        if (event.key.toLowerCase() === "v") setToolMode("select");
        if (event.key.toLowerCase() === "h") setToolMode("pan");
        if (event.key.toLowerCase() === "z") setToolMode("zoom");
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setIsSpacePanning(false);
        setPanDrag(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
  }, [currentPage?.id]);

  useEffect(() => {
    if (!authToken || !currentPage?.project_id || !currentPage?.server_page_id) return;
    const timer = window.setTimeout(() => {
      void upsertLastSession(
        {
          project_id: currentPage.project_id,
          page_id: currentPage.server_page_id,
          file_name: currentPage.file_name,
          view_params: {
            active_page_index: activePageIndex,
            zoom_percent: zoomPercent,
            pan_x: panOffset.x,
            pan_y: panOffset.y,
            show_original: showOriginalImage
          }
        },
        authToken
      ).catch(() => {
        // silent best-effort
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    authToken,
    currentPage?.project_id,
    currentPage?.server_page_id,
    currentPage?.file_name,
    activePageIndex,
    zoomPercent,
    panOffset.x,
    panOffset.y,
    showOriginalImage
  ]);

  useEffect(() => {
    if (!authToken || !currentPage?.project_id) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const progress = await fetchProjectProgress(currentPage.project_id as string, authToken);
        if (!cancelled) setProjectProgress(progress);
      } catch {
        if (!cancelled) setProjectProgress(null);
      }
    };
    void pull();
    const interval = window.setInterval(() => void pull(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authToken, currentPage?.project_id]);

  const updateCurrentPage = (updater: (page: PageDoc) => PageDoc) => {
    setPages((current) => current.map((page, idx) => (idx === activePageIndex ? updater(page) : page)));
  };

  const mapServerPatch = (patch: Partial<EditorRegion>) => {
    const next: Partial<{
      translated_text: string;
      review_status: "todo" | "edited" | "approved";
      note: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = {};
    if (patch.translated_text !== undefined) next.translated_text = patch.translated_text;
    if (patch.review_status !== undefined) next.review_status = patch.review_status;
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.x !== undefined) next.x = patch.x;
    if (patch.y !== undefined) next.y = patch.y;
    if (patch.width !== undefined) next.width = patch.width;
    if (patch.height !== undefined) next.height = patch.height;
    return next;
  };

  const scheduleRegionAutosave = (
    page: PageDoc,
    regionId: string,
    patch: Partial<{
      translated_text: string;
      review_status: "todo" | "edited" | "approved";
      note: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>
  ) => {
    if (!authToken || !page.project_id || !page.server_page_id) return;
    const serverRegionId = page.region_id_map[regionId];
    if (!serverRegionId) return;
    if (!Object.keys(patch).length) return;
    const key = `${page.server_page_id}:${serverRegionId}`;
    const existing = saveTimersRef.current[key];
    if (existing) window.clearTimeout(existing);
    saveTimersRef.current[key] = window.setTimeout(() => {
      void patchRegion(
        {
          projectId: page.project_id as string,
          pageId: page.server_page_id as string,
          regionId: serverRegionId,
          patch
        },
        authToken
      ).catch(() => {
        setNotice("Не удалось автосохранить часть правок.");
      });
    }, 350);
  };

  const updateRegion = (id: string, patch: Partial<EditorRegion>) => {
    const pageSnapshot = currentPage;
    updateCurrentPage((page) => ({
      ...page,
      regions: page.regions.map((region) => {
        if (region.id !== id) return region;
        const next = { ...region, ...patch };
        if (patch.translated_text !== undefined && next.review_status === "todo" && patch.translated_text.trim()) {
          next.review_status = "edited";
        }
        return next;
      })
    }));
    if (pageSnapshot) scheduleRegionAutosave(pageSnapshot, id, mapServerPatch(patch));
  };

  const updateMaskRegion = (id: string, patch: Partial<MaskRegion>) => {
    updateCurrentPage((page) => ({
      ...page,
      mask_regions: page.mask_regions.map((region) => {
        if (region.id !== id) return region;
        const next: MaskRegion = {
          ...region,
          ...patch
        };
        if (patch.polygon !== undefined) next.polygon = normalizePolygon(patch.polygon);
        return next;
      })
    }));
  };

  const deleteSelectedTextRegion = () => {
    if (!currentPage || !currentPage.selected_region_id) return;
    const selectedId = currentPage.selected_region_id;
    updateCurrentPage((page) => {
      const nextRegions = page.regions.filter((region) => region.id !== selectedId);
      return {
        ...page,
        regions: nextRegions,
        selected_region_id: nextRegions[0]?.id ?? null
      };
    });
  };

  const deleteSelectedMaskRegion = () => {
    if (!currentPage || !currentPage.selected_mask_region_id) return;
    const selectedId = currentPage.selected_mask_region_id;
    updateCurrentPage((page) => {
      const nextRegions = page.mask_regions.filter((region) => region.id !== selectedId);
      return {
        ...page,
        mask_regions: nextRegions,
        selected_mask_region_id: nextRegions[0]?.id ?? null
      };
    });
  };

  const onPickFiles = async (filesList: FileList | null) => {
    if (!filesList || filesList.length === 0) return;

    const files = Array.from(filesList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;

    const loaded: PageDoc[] = [];
    for (const file of files) {
      const preview = await fileToDataURL(file);
      const image_meta = await imageMetaFromDataURL(preview);
      loaded.push({
        id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        file_name: file.name,
        original_preview: preview,
        preview,
        processed_preview: null,
        image_meta,
        regions: [],
        mask_regions: [],
        project_id: null,
        server_page_id: null,
        region_id_map: {},
        selected_region_id: null,
        selected_mask_region_id: null,
        latest_job_id: null,
        pipeline_status: "idle",
        pipeline_error: null
      });
    }

    setPages((current) => [...current, ...loaded]);
    if (!currentPage) setActivePageIndex(0);
  };

  const runPipelineForCurrent = async () => {
    if (!currentPage) return;

    updateCurrentPage((page) => ({ ...page, pipeline_status: "running", pipeline_error: null }));

    try {
      if (!authToken) {
        setNotice("API ещё не готова. Подождите пару секунд и попробуйте снова.");
        updateCurrentPage((page) => ({ ...page, pipeline_status: "idle" }));
        return;
      }

      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = await createPipelineJob(
        {
          file: currentPage.file,
          targetLang,
          provider: (pipelineConfig.detector?.provider as "stub" | "huggingface" | "custom") || "custom",
          requestId,
          projectId: currentPage.project_id ?? undefined,
          projectName: currentPage.file_name.replace(/\.[a-z0-9]+$/i, ""),
          pipelineConfig,
          inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx,
          inpaintTextExpandPx: maskControls.inpaintTextExpandPx,
          inpaintBubbleScale: maskControls.inpaintBubbleScale,
          inpaintTextScale: maskControls.inpaintTextScale
        },
        authToken
      );
      updateCurrentPage((page) => ({ ...page, latest_job_id: created.job_id }));

      let finalStatus: "done" | "failed" | "canceled" | null = null;
      for (let attempt = 0; attempt < PIPELINE_POLL_MAX_ATTEMPTS; attempt += 1) {
        const status = await fetchPipelineJob(created.job_id, authToken);
        if (status.status === "done" || status.status === "failed" || status.status === "canceled") {
          finalStatus = status.status;
          if (status.status === "failed" || status.status === "canceled") {
            throw new Error(status.error_message || "Pipeline job failed");
          }

          const serverRegions = await fetchPageRegions(
            { projectId: created.project_id, pageId: created.page_id },
            authToken
          );

          const mapped = serverRegions.map((region) =>
            toEditorRegion({
              id: region.external_region_id,
              x: region.x,
              y: region.y,
              width: region.width,
              height: region.height,
              source_text: region.source_text,
              translated_text: region.translated_text,
              confidence: region.confidence
            })
          );

          const regionMap = serverRegions.reduce<Record<string, string>>((acc, region) => {
            acc[region.external_region_id] = region.id;
            return acc;
          }, {});

          let maskRegions: MaskRegion[] = [];
          try {
            const response = await previewMask({
              file: currentPage.file,
              provider: "custom",
              inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx,
              inpaintTextExpandPx: maskControls.inpaintTextExpandPx,
              inpaintBubbleScale: maskControls.inpaintBubbleScale,
              inpaintTextScale: maskControls.inpaintTextScale
            });
            maskRegions = response.regions;
          } catch {
            // Mask preview is optional here; user can retry manually.
          }

          updateCurrentPage((page) => ({
            ...page,
            preview: page.original_preview,
            processed_preview: null,
            mask_regions: maskRegions,
            project_id: created.project_id,
            server_page_id: created.page_id,
            region_id_map: regionMap,
            regions: mapped,
            selected_region_id: mapped[0]?.id ?? null,
            selected_mask_region_id: maskRegions[0]?.id ?? null,
            latest_job_id: created.job_id,
            pipeline_status: "done",
            pipeline_error: null
          }));
          window.localStorage.setItem(
            "mangaflow_last_session",
            JSON.stringify({ project_id: created.project_id, page_id: created.page_id, file_name: currentPage.file_name })
          );
          setDraftSourceText(mapped[0]?.source_text ?? "");
          setDraftTranslatedText(mapped[0]?.translated_text ?? "");
          setShowMaskPreview(maskRegions.length > 0);
          setShowOriginalImage(true);
          setNotice("Детекция завершена. Проверьте маски, при необходимости поправьте и нажмите 'Применить заливку'.");
          break;
        }
        await sleep(PIPELINE_POLL_INTERVAL_MS);
      }
      if (!finalStatus) {
        throw new Error("Pipeline still running. First model warm-up can take a few minutes. Please retry shortly.");
      }
    } catch (e) {
      updateCurrentPage((page) => ({
        ...page,
        pipeline_status: "error",
        pipeline_error: e instanceof Error ? e.message : "Pipeline error"
      }));
    }
  };

  const queuePipelineForAllPages = async () => {
    if (!authToken || pages.length === 0) {
      setNotice("Сначала дождитесь инициализации API.");
      return;
    }
    let resolvedProjectId = currentPage?.project_id ?? null;
    let queued = 0;
    for (let idx = 0; idx < pages.length; idx += 1) {
      const page = pages[idx];
      try {
        const requestId = `batch-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
        const created = await createPipelineJob(
          {
            file: page.file,
            targetLang,
            provider: (pipelineConfig.detector?.provider as "stub" | "huggingface" | "custom") || "custom",
            requestId,
            projectId: resolvedProjectId ?? undefined,
            projectName: page.file_name.replace(/\.[a-z0-9]+$/i, ""),
            pageIndex: idx + 1,
            pipelineConfig,
            inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx,
            inpaintTextExpandPx: maskControls.inpaintTextExpandPx,
            inpaintBubbleScale: maskControls.inpaintBubbleScale,
            inpaintTextScale: maskControls.inpaintTextScale
          },
          authToken
        );
        resolvedProjectId = created.project_id;
        queued += 1;
        setPages((current) =>
          current.map((item, pageIdx) =>
            pageIdx === idx
              ? {
                  ...item,
                  project_id: created.project_id,
                  server_page_id: created.page_id,
                  latest_job_id: created.job_id,
                  pipeline_status: "running",
                  pipeline_error: null
                }
              : item
          )
        );
      } catch {
        setPages((current) =>
          current.map((item, pageIdx) =>
            pageIdx === idx
              ? {
                  ...item,
                  pipeline_status: "error",
                  pipeline_error: "Не удалось поставить страницу в очередь."
                }
              : item
          )
        );
      }
    }
    if (resolvedProjectId) {
      void upsertLastSession(
        {
          project_id: resolvedProjectId,
          page_id: currentPage?.server_page_id ?? null,
          file_name: currentPage?.file_name ?? null,
          view_params: {}
        },
        authToken
      ).catch(() => undefined);
    }
    setNotice(`В очередь отправлено страниц: ${queued}/${pages.length}.`);
  };

  const cancelCurrentPipelineJob = async () => {
    if (!authToken || !currentPage?.latest_job_id) {
      setNotice("Нет активной job для отмены.");
      return;
    }
    try {
      const result = await cancelPipelineJob(currentPage.latest_job_id, authToken);
      updateCurrentPage((page) => ({
        ...page,
        pipeline_status: result.status === "canceled" ? "error" : page.pipeline_status,
        pipeline_error: result.status === "canceled" ? "Обработка отменена." : page.pipeline_error
      }));
      setNotice(`Статус отмены: ${result.status}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось отменить job.");
    }
  };

  const translateCurrentDraft = async () => {
    const source = draftSourceText.trim();
    if (!source) {
      setDraftTranslatedText("");
      return;
    }
    setTranslationLoading(true);
    try {
      const translated = await translateTexts({
        provider: resolveProvider(translatorEngine),
        targetLang,
        texts: [source]
      });
      setDraftTranslatedText(translated[0] ?? "");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Ошибка перевода.");
    } finally {
      setTranslationLoading(false);
    }
  };

  const insertDraftToSelected = () => {
    if (!selectedRegion) return;
    updateRegion(selectedRegion.id, {
      source_text: draftSourceText,
      translated_text: draftTranslatedText,
      review_status: draftTranslatedText.trim() ? "edited" : selectedRegion.review_status
    });
  };

  const translateAll = async () => {
    if (!currentPage) return;
    setTranslationLoading(true);
    try {
      const sourceTexts = currentPage.regions.map((region) => region.source_text || "");
      const translated = await translateTexts({
        provider: resolveProvider(translatorEngine),
        targetLang,
        texts: sourceTexts
      });
      const updates: Array<{ id: string; translated_text: string; review_status: ReviewStatus }> = currentPage.regions.map((region, idx) => {
        const nextText = translated[idx] ?? "";
        const nextStatus: ReviewStatus = region.review_status === "approved" ? "approved" : nextText.trim() ? "edited" : region.review_status;
        return { id: region.id, translated_text: nextText, review_status: nextStatus };
      });
      updateCurrentPage((page) => ({
        ...page,
        regions: page.regions.map((region) => {
          const patch = updates.find((item) => item.id === region.id);
          if (!patch) return region;
          return { ...region, translated_text: patch.translated_text, review_status: patch.review_status };
        })
      }));
      for (const patch of updates) {
        scheduleRegionAutosave(currentPage, patch.id, {
          translated_text: patch.translated_text,
          review_status: patch.review_status
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Ошибка массового перевода.");
    } finally {
      setTranslationLoading(false);
    }
  };

  const previewMaskForCurrent = async () => {
    if (!currentPage) return;
    setMaskPreviewLoading(true);
    setMaskPreviewError(null);
    try {
      const response = await previewMask({
        file: currentPage.file,
        provider: "custom",
        inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx,
        inpaintTextExpandPx: maskControls.inpaintTextExpandPx,
        inpaintBubbleScale: maskControls.inpaintBubbleScale,
        inpaintTextScale: maskControls.inpaintTextScale
      });
      updateCurrentPage((page) => ({
        ...page,
        mask_regions: response.regions,
        selected_mask_region_id: response.regions[0]?.id ?? null
      }));
      setShowMaskPreview(true);
      setShowOriginalImage(true);
    } catch (error) {
      setMaskPreviewError(error instanceof Error ? error.message : "Не удалось построить маску.");
    } finally {
      setMaskPreviewLoading(false);
    }
  };

  const applyInpaintForCurrent = async () => {
    if (!currentPage) return;
    if (!currentPage.mask_regions.length) {
      setNotice("Сначала постройте и проверьте маску.");
      return;
    }
    setInpaintLoading(true);
    setMaskPreviewError(null);
    try {
      const blob = await previewInpaint({ file: currentPage.file, regions: currentPage.mask_regions });
      const outputFile = new File([blob], `inpaint-${currentPage.file_name}`, { type: blob.type || "image/png" });
      const dataUrl = await fileToDataURL(outputFile);
      const nextMeta = await imageMetaFromDataURL(dataUrl);
      updateCurrentPage((page) => ({
        ...page,
        preview: dataUrl,
        processed_preview: dataUrl,
        image_meta: nextMeta,
        pipeline_error: null
      }));
      setShowOriginalImage(false);
      setNotice("Заливка применена по текущим маскам.");
    } catch (error) {
      setMaskPreviewError(error instanceof Error ? error.message : "Не удалось применить заливку.");
    } finally {
      setInpaintLoading(false);
    }
  };

  const resetPanelsLayout = () => {
    setPanels({
      workflow: { x: 14, y: 14, width: 340, collapsed: false },
      text: { x: 14, y: 14, width: 380, collapsed: false }
    });
  };

  const removeCurrentPage = () => {
    if (!currentPage) return;
    const removedPageId = currentPage.id;
    const removedProjectId = currentPage.project_id;
    const removedServerPageId = currentPage.server_page_id;

    setPages((current) => current.filter((page) => page.id !== removedPageId));
    const nextLength = Math.max(0, pages.length - 1);
    setActivePageIndex((idx) => (nextLength === 0 ? 0 : Math.min(idx, nextLength - 1)));

    if (removedProjectId && removedServerPageId) {
      const raw = window.localStorage.getItem("mangaflow_last_session");
      if (raw) {
        try {
          const last = JSON.parse(raw) as { project_id?: string; page_id?: string };
          if (last.project_id === removedProjectId && last.page_id === removedServerPageId) {
            window.localStorage.removeItem("mangaflow_last_session");
          }
        } catch {
          window.localStorage.removeItem("mangaflow_last_session");
        }
      }
    }

    setDraftSourceText("");
    setDraftTranslatedText("");
    setShowMaskPreview(false);
    setShowOriginalImage(false);
    setNotice("Страница удалена из текущей сессии.");
  };

  const goToPrevPage = () => setActivePageIndex((idx) => Math.max(0, idx - 1));
  const goToNextPage = () => setActivePageIndex((idx) => Math.min(pages.length - 1, idx + 1));

  const onConfirmFinish = async () => {
    if (!currentPage) return;

    const selectedPages = exportOptions.scope === "all" ? pages : [currentPage];
    const prefix = exportOptions.prefix.trim() || "mangaflow";

    if (exportOptions.export_json) {
      for (const page of selectedPages) {
        const payload = {
          file_name: page.file_name,
          target_lang: targetLang,
          regions: exportOptions.include_styles
            ? page.regions
            : page.regions.map(({ id, x, y, width, height, source_text, translated_text, confidence }) => ({
                id,
                x,
                y,
                width,
                height,
                source_text,
                translated_text,
                confidence
              }))
        };
        downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${prefix}-${page.file_name}.json`);
      }
    }

    if (exportOptions.export_png) {
      for (const page of selectedPages) {
        const dataUrl = await renderPageToPng(page);
        if (dataUrl) {
          downloadDataUrl(dataUrl, `${prefix}-${page.file_name.replace(/\.[^.]+$/, "")}.png`);
        }
      }
    }

    if (exportOptions.export_project) {
      const projectPayload = {
        project_name: prefix,
        created_at: new Date().toISOString(),
        target_lang: targetLang,
        source_lang: sourceLang,
        translator: translatorEngine,
        smart_fill: smartFillEnabled,
        pages: selectedPages.map((page) => ({
          id: page.id,
          file_name: page.file_name,
          image_meta: page.image_meta,
          regions: page.regions
        }))
      };
      downloadBlob(new Blob([JSON.stringify(projectPayload, null, 2)], { type: "application/json" }), `${prefix}-project.json`);
    }

    setFinishModalOpen(false);
    setNotice("Скачивание запущено. Проверьте загрузки браузера.");
  };

  const onExportServerZip = async () => {
    if (!authToken || !currentPage?.project_id) {
      setNotice("ZIP экспорт доступен только для сохраненного проекта.");
      return;
    }
    try {
      const blob = await exportProjectZip(currentPage.project_id, authToken);
      downloadBlob(blob, `${currentPage.file_name.replace(/\.[^.]+$/, "")}-export.zip`);
      setNotice("ZIP экспорт подготовлен.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось экспортировать ZIP.");
    }
  };

  const zoomAtPoint = (clientX: number, clientY: number, delta: number) => {
    if (!stageRef.current) return;

    const nextZoom = clamp(zoomPercent + delta, 40, 600);
    if (nextZoom === zoomPercent) return;

    const stageRect = stageRef.current.getBoundingClientRect();
    const pointerX = clientX - stageRect.left;
    const pointerY = clientY - stageRect.top;

    const currentLeft = displayedRect.x + panOffset.x;
    const currentTop = displayedRect.y + panOffset.y;

    const anchorX = (pointerX - currentLeft) / Math.max(1, displayedRect.width);
    const anchorY = (pointerY - currentTop) / Math.max(1, displayedRect.height);

    const zoomFactor = nextZoom / zoomPercent;
    const nextWidth = displayedRect.width * zoomFactor;
    const nextHeight = displayedRect.height * zoomFactor;

    const nextCenterX = (stageSize.width - nextWidth) / 2;
    const nextCenterY = (stageSize.height - nextHeight) / 2;

    const nextLeft = pointerX - anchorX * nextWidth;
    const nextTop = pointerY - anchorY * nextHeight;

    setZoomPercent(nextZoom);
    setPanOffset({
      x: nextLeft - nextCenterX,
      y: nextTop - nextCenterY
    });
  };

  const panByWheel = (deltaX: number, deltaY: number, horizontalPreferred: boolean) => {
    const factor = 1.15;
    const nextX = horizontalPreferred ? panOffset.x - deltaY * factor : panOffset.x - deltaX * factor;
    const nextY = horizontalPreferred ? panOffset.y : panOffset.y - deltaY * factor;
    setPanOffset({ x: nextX, y: nextY });
  };

  const onStageWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const shouldZoom = effectiveToolMode === "zoom" || event.ctrlKey || event.metaKey;
    if (shouldZoom) {
      const delta = event.deltaY < 0 ? 10 : -10;
      zoomAtPoint(event.clientX, event.clientY, delta);
      return;
    }

    const horizontalPreferred = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    panByWheel(event.deltaX, event.deltaY, horizontalPreferred);
  };

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const handler = (event: WheelEvent) => onStageWheel(event);
    element.addEventListener("wheel", handler, { passive: false, capture: true });
    return () => {
      element.removeEventListener("wheel", handler, { capture: true } as EventListenerOptions);
    };
  }, [onStageWheel]);

  const resetViewToDefault = () => {
    setZoomPercent(100);
    setPanOffset({ x: 0, y: 0 });
  };

  const renderFloatingPanel = (
    id: PanelId,
    title: string,
    content: React.ReactNode,
    side: "left" | "right"
  ) => {
    const panel = panels[id];
    const style: React.CSSProperties = {
      position: "absolute",
      left: side === "left" ? panel.x : undefined,
      right: side === "right" ? panel.x : undefined,
      top: panel.y,
      width: panel.collapsed ? 170 : panel.width,
      zIndex: 30
    };

    return (
      <div
        className="tool-window rounded-2xl"
        style={style}
        onWheelCapture={(event) => {
          event.stopPropagation();
        }}
      >
        <div
          className="flex cursor-move items-center justify-between border-b border-white/10 px-3 py-2"
          onMouseDown={(event) => {
            setPanelDrag({
              id,
              side,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startX: panel.x,
              startY: panel.y
            });
          }}
        >
          <p className="text-sm font-semibold">{title}</p>
          <button
            className="rounded bg-white/15 px-2 py-1 text-xs"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setPanels((current) => ({ ...current, [id]: { ...current[id], collapsed: !current[id].collapsed } }));
            }}
          >
            {panel.collapsed ? "Развернуть" : "Свернуть"}
          </button>
        </div>
        {!panel.collapsed ? <div className="max-h-[calc(100vh-430px)] overflow-auto p-3">{content}</div> : <div className="px-3 py-2 text-xs text-white/70">Островок инструментов</div>}
      </div>
    );
  };

  if (!currentPage) {
    return (
      <section className="mx-auto w-full max-w-[1200px] px-4 pb-10">
        <div className="panel mt-6 rounded-3xl p-8 sm:p-12">
          <p className="text-xs uppercase tracking-[0.24em] text-white/55">Step 1</p>
          <h2 className="mt-2 text-3xl font-semibold sm:text-4xl">Загрузите страницы манги</h2>
          <p className="mt-3 max-w-3xl text-white/70">
            Пока файлы не загружены, редактор не показывается. Можно загрузить сразу несколько страниц, после чего будет доступно переключение между ними.
          </p>

          <div className="mt-8 rounded-2xl border border-dashed border-white/25 bg-black/25 p-6">
            <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void onPickFiles(e.target.files)} />
            <button className="rounded-xl bg-[#ff9d42] px-6 py-3 font-semibold text-black" onClick={() => inputRef.current?.click()}>Выбрать файлы</button>
            <p className="mt-3 text-sm text-white/60">Поддерживаются PNG/JPEG/WEBP. Можно выбрать несколько файлов сразу.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[1580px] px-4 pb-8">
      <div className="canvas-hud mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm text-white/90">
        <div className="flex items-center gap-2">
          <button className="rounded bg-white/15 px-3 py-1 disabled:opacity-30" onClick={goToPrevPage} disabled={activePageIndex === 0}>Предыдущая</button>
          <span>Страница {activePageIndex + 1} / {pages.length}</span>
          <button className="rounded bg-white/15 px-3 py-1 disabled:opacity-30" onClick={goToNextPage} disabled={activePageIndex >= pages.length - 1}>Следующая</button>
          <button className="rounded bg-white/15 px-3 py-1" onClick={() => inputRef.current?.click()}>Добавить файлы</button>
          <button className="rounded bg-red-500/25 px-3 py-1" onClick={removeCurrentPage}>Удалить страницу</button>
          <button
            className="rounded bg-white/15 px-3 py-1 disabled:opacity-40"
            onClick={() => setShowOriginalImage((prev) => !prev)}
            disabled={!currentPage?.processed_preview}
          >
            {showOriginalImage ? "Показать после" : "Показать до"}
          </button>
          <button className="rounded bg-white/15 px-3 py-1" onClick={resetPanelsLayout}>Сброс панелей</button>
          <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void onPickFiles(e.target.files)} />
        </div>

        <div className="flex items-center gap-2">
          <div className="mr-2 flex items-center gap-1 rounded bg-white/10 p-1">
            <button
              className={`rounded px-2 py-1 text-xs ${toolMode === "select" ? "bg-[#ff9d42] text-black" : "bg-white/10 text-white"}`}
              onClick={() => setToolMode("select")}
              title="Мышка (V): выбрать текстовый сегмент"
            >
              Мышка V
            </button>
            <button
              className={`rounded px-2 py-1 text-xs ${toolMode === "pan" ? "bg-[#ff9d42] text-black" : "bg-white/10 text-white"}`}
              onClick={() => setToolMode("pan")}
              title="Рука (H): двигать изображение. Space - временно включить руку"
            >
              Рука H
            </button>
            <button
              className={`rounded px-2 py-1 text-xs ${toolMode === "zoom" ? "bg-[#ff9d42] text-black" : "bg-white/10 text-white"}`}
              onClick={() => setToolMode("zoom")}
              title="Лупа (Z): клик увеличивает, Shift+клик уменьшает"
            >
              Лупа Z
            </button>
          </div>
          <button className="rounded bg-white/15 px-3 py-1" onClick={() => setZoomPercent((v) => clamp(v - 10, 40, 600))}>-</button>
          <span>{zoomPercent}%</span>
          <button className="rounded bg-white/15 px-3 py-1" onClick={() => setZoomPercent((v) => clamp(v + 10, 40, 600))}>+</button>
          <input
            type="range"
            min={40}
            max={600}
            step={5}
            value={zoomPercent}
            onChange={(e) => setZoomPercent(Number(e.target.value))}
            className="w-28"
          />
          <button
            className="rounded bg-white/15 px-3 py-1"
            onClick={resetViewToDefault}
          >
            Fit 100%
          </button>
          <button className="rounded bg-white/15 px-3 py-1" onClick={resetViewToDefault}>
            Сброс вида
          </button>
          <label className="flex items-center gap-1"><span>Grid</span><input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /></label>
          <label className="flex items-center gap-1"><span>Сегменты</span><input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} /></label>
          <label className="flex items-center gap-1"><span>Текст</span><input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /></label>
          <button className="rounded bg-[#ff9d42] px-3 py-1 font-semibold text-black" onClick={() => setFinishModalOpen(true)}>Завершить редактирование</button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative h-[calc(100vh-300px)] min-h-[420px] overflow-hidden rounded-2xl bg-[#0b1019] overscroll-contain"
      >
        <div
          className={`absolute inset-0 z-20 ${
            effectiveToolMode === "zoom"
              ? "cursor-zoom-in"
              : effectiveToolMode === "pan"
                ? (panDrag ? "cursor-grabbing" : "cursor-grab")
              : "cursor-default"
          }`}
          style={{ pointerEvents: effectiveToolMode === "select" ? "none" : "auto" }}
          onContextMenu={(event) => {
            if (effectiveToolMode === "zoom") event.preventDefault();
          }}
          onMouseDown={(event) => {
            if (event.button !== 0 && event.button !== 1) return;
            if (effectiveToolMode === "zoom") {
              if (event.button !== 0) return;
              zoomAtPoint(event.clientX, event.clientY, event.shiftKey ? -10 : 10);
              return;
            }
            if (effectiveToolMode === "pan") {
              event.preventDefault();
              setPanDrag({
                startClientX: event.clientX,
                startClientY: event.clientY,
                startX: panOffset.x,
                startY: panOffset.y
              });
            }
          }}
        />
        <div
          className="absolute z-10 overflow-hidden rounded-xl"
          style={{
            left: `${displayedRect.x + panOffset.x}px`,
            top: `${displayedRect.y + panOffset.y}px`,
            width: `${displayedRect.width}px`,
            height: `${displayedRect.height}px`
          }}
        >
            <img src={displayImageSrc} alt={currentPage.file_name} className="absolute inset-0 h-full w-full object-cover" />

            {showGrid ? (
              <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "5% 5%" }} />
            ) : null}

            {showMaskPreview ? (
              <>
                <svg
                  className="absolute inset-0 h-full w-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  style={{ pointerEvents: effectiveToolMode === "select" ? "auto" : "none" }}
                >
                  {currentPage.mask_regions.map((region) => {
                    const selected = region.id === currentPage.selected_mask_region_id;
                    const fill = region.label === "bubble" ? "rgba(249, 115, 22, 0.28)" : "rgba(56, 189, 248, 0.22)";
                    const stroke = selected ? (region.label === "bubble" ? "#f97316" : "#38bdf8") : "transparent";
                    const polygon = normalizePolygon(region.polygon);
                    const onSelect = (event: React.MouseEvent<SVGElement>) => {
                      if (effectiveToolMode !== "select") return;
                      event.preventDefault();
                      event.stopPropagation();
                      updateCurrentPage((page) => ({ ...page, selected_mask_region_id: region.id }));
                      setRegionDrag({
                        kind: "mask",
                        mode: "move",
                        id: region.id,
                        startClientX: event.clientX,
                        startClientY: event.clientY,
                        startX: region.x,
                        startY: region.y,
                        startWidth: region.width,
                        startHeight: region.height,
                        startPolygon: polygon,
                        displayWidth: displayedRect.width,
                        displayHeight: displayedRect.height
                      });
                    };

                    if (polygon && polygon.length >= 3) {
                      return (
                        <polygon
                          key={`mask-poly-${region.id}`}
                          points={polygon.map((pt) => `${pt.x},${pt.y}`).join(" ")}
                          fill={fill}
                          stroke={stroke}
                          strokeWidth={selected ? 0.25 : 0}
                          onMouseDown={(event) => onSelect(event)}
                        />
                      );
                    }
                    return (
                      <rect
                        key={`mask-rect-${region.id}`}
                        x={region.x}
                        y={region.y}
                        width={region.width}
                        height={region.height}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={selected ? 0.25 : 0}
                        onMouseDown={(event) => onSelect(event)}
                      />
                    );
                  })}
                </svg>

                {currentPage.mask_regions.map((region) => {
                  const selected = region.id === currentPage.selected_mask_region_id;
                  if (!selected || effectiveToolMode !== "select") return null;
                  return (
                    <button
                      key={`mask-resize-${region.id}`}
                      className="absolute h-3 w-3 rounded-sm border border-white bg-[#0f172a]"
                      style={{
                        left: `${region.x + region.width}%`,
                        top: `${region.y + region.height}%`,
                        transform: "translate(-50%, -50%)",
                        cursor: "nwse-resize"
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setRegionDrag({
                          kind: "mask",
                          mode: "resize",
                          id: region.id,
                          startClientX: event.clientX,
                          startClientY: event.clientY,
                          startX: region.x,
                          startY: region.y,
                          startWidth: region.width,
                          startHeight: region.height,
                          startPolygon: normalizePolygon(region.polygon),
                          displayWidth: displayedRect.width,
                          displayHeight: displayedRect.height
                        });
                      }}
                    />
                  );
                })}
              </>
            ) : null}

            {showRegions && filteredRegions.map((region) => {
              const selected = region.id === currentPage.selected_region_id;
              const boxPixelHeight = (region.height / 100) * displayedRect.height;
              const fittedPreviewFontSize = Math.max(
                8,
                Math.min(region.font_size * displayedRect.scale, Math.max(10, boxPixelHeight / 2.6))
              );
              const outlinePx = Math.max(1, Math.round(region.outline_width));
              const textShadow = region.outline_enabled
                ? [
                    `-${outlinePx}px 0 ${region.outline_color}`,
                    `${outlinePx}px 0 ${region.outline_color}`,
                    `0 -${outlinePx}px ${region.outline_color}`,
                    `0 ${outlinePx}px ${region.outline_color}`
                  ].join(", ")
                : "none";
              return (
                <div
                  key={region.id}
                  className="absolute rounded-md text-left"
                  style={{
                    left: `${region.x}%`,
                    top: `${region.y}%`,
                    width: `${region.width}%`,
                    height: `${region.height}%`,
                    zIndex: selected ? 12 : 11,
                    backgroundColor: region.background_opacity > 0 ? hexToRgba(region.background_color, region.background_opacity) : "transparent",
                    backdropFilter: region.background_blur ? `blur(${region.background_blur}px)` : undefined,
                    boxShadow: selected ? "0 0 0 1px rgba(255,157,66,.95)" : "none"
                  }}
                  onMouseDown={(event) => {
                    if (effectiveToolMode !== "select") return;
                    event.preventDefault();
                    event.stopPropagation();
                    updateCurrentPage((page) => ({ ...page, selected_region_id: region.id }));
                    setRegionDrag({
                      kind: "text",
                      mode: "move",
                      id: region.id,
                      startClientX: event.clientX,
                      startClientY: event.clientY,
                      startX: region.x,
                      startY: region.y,
                      startWidth: region.width,
                      startHeight: region.height,
                      startPolygon: null,
                      displayWidth: displayedRect.width,
                      displayHeight: displayedRect.height
                    });
                  }}
                >
                  {showText ? (
                    <span
                      style={{
                        display: "block",
                        padding: "4px 6px",
                        fontFamily: region.font_family,
                        fontSize: `${fittedPreviewFontSize}px`,
                        fontStyle: region.font_style,
                        fontWeight: region.font_weight,
                        color: hexToRgba(region.text_color, region.text_opacity),
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        lineHeight: 1.15,
                        textShadow
                      }}
                    >
                      {region.translated_text || region.source_text || "(пусто)"}
                    </span>
                  ) : null}
                  {selected && effectiveToolMode === "select" ? (
                    <button
                      className="absolute h-3 w-3 rounded-sm border border-[#ff9d42] bg-black/70"
                      style={{ right: -6, bottom: -6, cursor: "nwse-resize" }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setRegionDrag({
                          kind: "text",
                          mode: "resize",
                          id: region.id,
                          startClientX: event.clientX,
                          startClientY: event.clientY,
                          startX: region.x,
                          startY: region.y,
                          startWidth: region.width,
                          startHeight: region.height,
                          startPolygon: null,
                          displayWidth: displayedRect.width,
                          displayHeight: displayedRect.height
                        });
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
        </div>

        {renderFloatingPanel(
          "workflow",
          "Перевод",
          <div className="space-y-2 text-xs">
            <div className="rounded-lg bg-[#121827] p-2">QA: {quality.approved}/{quality.total} ({quality.progress}%)</div>
            {projectProgress ? (
              <div className="rounded-lg bg-[#121827] p-2">
                Прогресс проекта: {projectProgress.done}/{projectProgress.total_pages} done, {projectProgress.running + projectProgress.retrying} running
              </div>
            ) : null}
            <div className="rounded-lg bg-[#121827] p-2 space-y-2">
              <p className="text-[11px] uppercase tracking-[0.14em] text-white/60">Pipeline config</p>
              <label className="block">
                Detector
                <select
                  className="mt-1 w-full rounded bg-[#141b2a] p-2"
                  value={pipelineConfig.detector?.provider || "custom"}
                  onChange={(e) => setPipelineConfig((prev) => ({ ...prev, detector: { ...(prev.detector || {}), provider: e.target.value } }))}
                >
                  {(providerCatalog.length ? providerCatalog : [{ name: "custom", enabled: true }, { name: "stub", enabled: true }]).map((provider) => (
                    <option key={`det-${provider.name}`} value={provider.name} disabled={!provider.enabled}>{provider.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                Inpainter
                <select
                  className="mt-1 w-full rounded bg-[#141b2a] p-2"
                  value={pipelineConfig.inpainter?.provider || "custom"}
                  onChange={(e) => setPipelineConfig((prev) => ({ ...prev, inpainter: { ...(prev.inpainter || {}), provider: e.target.value } }))}
                >
                  {(providerCatalog.length ? providerCatalog : [{ name: "custom", enabled: true }, { name: "stub", enabled: true }]).map((provider) => (
                    <option key={`inp-${provider.name}`} value={provider.name} disabled={!provider.enabled}>{provider.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                OCR
                <select
                  className="mt-1 w-full rounded bg-[#141b2a] p-2"
                  value={pipelineConfig.ocr?.provider || "custom"}
                  onChange={(e) => setPipelineConfig((prev) => ({ ...prev, ocr: { ...(prev.ocr || {}), provider: e.target.value } }))}
                >
                  {(providerCatalog.length ? providerCatalog : [{ name: "custom", enabled: true }, { name: "stub", enabled: true }]).map((provider) => (
                    <option key={`ocr-${provider.name}`} value={provider.name} disabled={!provider.enabled}>{provider.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                Translator
                <select
                  className="mt-1 w-full rounded bg-[#141b2a] p-2"
                  value={pipelineConfig.translator?.provider || "custom"}
                  onChange={(e) => {
                    setPipelineConfig((prev) => ({ ...prev, translator: { ...(prev.translator || {}), provider: e.target.value } }));
                    setTranslatorEngine(e.target.value);
                  }}
                >
                  {(providerCatalog.length ? providerCatalog : [{ name: "custom", enabled: true }, { name: "stub", enabled: true }]).map((provider) => (
                    <option key={`tr-${provider.name}`} value={provider.name} disabled={!provider.enabled}>{provider.name}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Detector model"
                  value={pipelineConfig.detector?.model || "default"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    detector: {
                      provider: prev.detector?.provider || "custom",
                      model: e.target.value,
                      version: prev.detector?.version || "v1",
                      params: prev.detector?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Detector version"
                  value={pipelineConfig.detector?.version || "v1"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    detector: {
                      provider: prev.detector?.provider || "custom",
                      model: prev.detector?.model || "default",
                      version: e.target.value,
                      params: prev.detector?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Inpainter model"
                  value={pipelineConfig.inpainter?.model || "default"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    inpainter: {
                      provider: prev.inpainter?.provider || "custom",
                      model: e.target.value,
                      version: prev.inpainter?.version || "v1",
                      params: prev.inpainter?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Inpainter version"
                  value={pipelineConfig.inpainter?.version || "v1"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    inpainter: {
                      provider: prev.inpainter?.provider || "custom",
                      model: prev.inpainter?.model || "default",
                      version: e.target.value,
                      params: prev.inpainter?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="OCR model"
                  value={pipelineConfig.ocr?.model || "default"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    ocr: {
                      provider: prev.ocr?.provider || "custom",
                      model: e.target.value,
                      version: prev.ocr?.version || "v1",
                      params: prev.ocr?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="OCR version"
                  value={pipelineConfig.ocr?.version || "v1"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    ocr: {
                      provider: prev.ocr?.provider || "custom",
                      model: prev.ocr?.model || "default",
                      version: e.target.value,
                      params: prev.ocr?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Translator model"
                  value={pipelineConfig.translator?.model || "default"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    translator: {
                      provider: prev.translator?.provider || "custom",
                      model: e.target.value,
                      version: prev.translator?.version || "v1",
                      params: prev.translator?.params || {}
                    }
                  }))}
                />
                <input
                  className="rounded bg-[#141b2a] p-2"
                  placeholder="Translator version"
                  value={pipelineConfig.translator?.version || "v1"}
                  onChange={(e) => setPipelineConfig((prev) => ({
                    ...prev,
                    translator: {
                      provider: prev.translator?.provider || "custom",
                      model: prev.translator?.model || "default",
                      version: e.target.value,
                      params: prev.translator?.params || {}
                    }
                  }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select className="rounded-lg bg-[#141b2a] p-2" value={translatorEngine} onChange={(e) => setTranslatorEngine(e.target.value)}>
                <option value="custom">NLLB (custom)</option>
                <option value="stub">Stub translate</option>
              </select>
              <select className="rounded-lg bg-[#141b2a] p-2" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                <option value="ja">Japanese</option>
                <option value="en">English</option>
                <option value="ru">Russian</option>
              </select>
            </div>
            <textarea className="w-full rounded-lg bg-[#141b2a] p-2" rows={3} value={draftSourceText} onChange={(e) => setDraftSourceText(e.target.value)} placeholder="Исходный текст" />
            <select className="w-full rounded-lg bg-[#141b2a] p-2" value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
              <option value="ru">Russian</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
            </select>
            <textarea className="w-full rounded-lg bg-[#141b2a] p-2" rows={3} value={draftTranslatedText} onChange={(e) => setDraftTranslatedText(e.target.value)} placeholder="Переведенный текст" />
            <div className="grid grid-cols-2 gap-2">
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={insertDraftToSelected}>Вставить</button>
              <button className="rounded-lg bg-white/15 px-2 py-2 disabled:opacity-50" onClick={() => void translateCurrentDraft()} disabled={translationLoading}>
                {translationLoading ? "Перевод..." : "Перевести"}
              </button>
              <button className="rounded-lg bg-white/15 px-2 py-2 disabled:opacity-50" onClick={() => void translateAll()} disabled={translationLoading || !currentPage.regions.length}>
                Перевести все
              </button>
              <button
                className="rounded-lg bg-white/15 px-2 py-2"
                onClick={runPipelineForCurrent}
                disabled={currentPage.pipeline_status === "running" || !authToken}
                title={!authToken ? "Ожидаем инициализацию API" : undefined}
              >
                {currentPage.pipeline_status === "running" ? "Обработка..." : !authToken ? "Инициализация..." : "Детекция"}
              </button>
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={() => void queuePipelineForAllPages()} disabled={!authToken || pages.length < 2}>
                Batch queue
              </button>
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={() => void cancelCurrentPipelineJob()} disabled={!authToken || !currentPage.latest_job_id}>
                Отменить job
              </button>
            </div>
            <div className="rounded-lg bg-[#121827] p-3">
              <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-white/60">Маска заливки</p>
              <label className="block">Bubble +px
                <input
                  type="range"
                  className="mt-1 w-full"
                  min={0}
                  max={40}
                  step={1}
                  value={maskControls.inpaintBubbleExpandPx}
                  onChange={(e) => setMaskControls((prev) => ({ ...prev, inpaintBubbleExpandPx: Number(e.target.value) }))}
                />
              </label>
              <label className="block mt-2">Text +px
                <input
                  type="range"
                  className="mt-1 w-full"
                  min={0}
                  max={30}
                  step={1}
                  value={maskControls.inpaintTextExpandPx}
                  onChange={(e) => setMaskControls((prev) => ({ ...prev, inpaintTextExpandPx: Number(e.target.value) }))}
                />
              </label>
              <label className="block mt-2">Bubble scale
                <input
                  type="range"
                  className="mt-1 w-full"
                  min={0.6}
                  max={2.0}
                  step={0.01}
                  value={maskControls.inpaintBubbleScale}
                  onChange={(e) => setMaskControls((prev) => ({ ...prev, inpaintBubbleScale: Number(e.target.value) }))}
                />
              </label>
              <label className="block mt-2">Text scale
                <input
                  type="range"
                  className="mt-1 w-full"
                  min={0.6}
                  max={2.0}
                  step={0.01}
                  value={maskControls.inpaintTextScale}
                  onChange={(e) => setMaskControls((prev) => ({ ...prev, inpaintTextScale: Number(e.target.value) }))}
                />
              </label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button className="rounded-lg bg-white/15 px-2 py-2" onClick={() => void previewMaskForCurrent()} disabled={maskPreviewLoading}>
                  {maskPreviewLoading ? "Строим..." : "Проверить маску"}
                </button>
                <button
                  className="rounded-lg bg-white/15 px-2 py-2"
                  onClick={() => setShowMaskPreview((prev) => !prev)}
                  disabled={!currentPage.mask_regions.length}
                >
                  {showMaskPreview ? "Скрыть маску" : "Показать маску"}
                </button>
              </div>
              <button
                className="mt-2 w-full rounded-lg bg-[#ff9d42] px-2 py-2 font-semibold text-black disabled:opacity-50"
                onClick={() => void applyInpaintForCurrent()}
                disabled={inpaintLoading || !currentPage.mask_regions.length}
              >
                {inpaintLoading ? "Заливка..." : "Применить заливку"}
              </button>

              {selectedMaskRegion ? (
                <div className="mt-3 rounded-lg bg-black/20 p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span>{selectedMaskRegion.id} ({selectedMaskRegion.label})</span>
                    <button className="rounded bg-red-500/30 px-2 py-1" onClick={deleteSelectedMaskRegion}>Удалить</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label>X
                      <input
                        type="number"
                        className="mt-1 w-full rounded bg-[#141b2a] p-1"
                        min={0}
                        max={100}
                        step={0.1}
                        value={selectedMaskRegion.x}
                        onChange={(e) => {
                          const nextX = clamp(Number(e.target.value), 0, 100 - selectedMaskRegion.width);
                          const dx = nextX - selectedMaskRegion.x;
                          const poly = normalizePolygon(selectedMaskRegion.polygon)?.map((pt) => ({ x: pt.x + dx, y: pt.y })) ?? null;
                          updateMaskRegion(selectedMaskRegion.id, { x: nextX, polygon: poly });
                        }}
                      />
                    </label>
                    <label>Y
                      <input
                        type="number"
                        className="mt-1 w-full rounded bg-[#141b2a] p-1"
                        min={0}
                        max={100}
                        step={0.1}
                        value={selectedMaskRegion.y}
                        onChange={(e) => {
                          const nextY = clamp(Number(e.target.value), 0, 100 - selectedMaskRegion.height);
                          const dy = nextY - selectedMaskRegion.y;
                          const poly = normalizePolygon(selectedMaskRegion.polygon)?.map((pt) => ({ x: pt.x, y: pt.y + dy })) ?? null;
                          updateMaskRegion(selectedMaskRegion.id, { y: nextY, polygon: poly });
                        }}
                      />
                    </label>
                    <label>W
                      <input
                        type="number"
                        className="mt-1 w-full rounded bg-[#141b2a] p-1"
                        min={1}
                        max={100}
                        step={0.1}
                        value={selectedMaskRegion.width}
                        onChange={(e) => {
                          const nextW = clamp(Number(e.target.value), 1, 100 - selectedMaskRegion.x);
                          const poly = transformPolygonByBox(
                            normalizePolygon(selectedMaskRegion.polygon),
                            {
                              x: selectedMaskRegion.x,
                              y: selectedMaskRegion.y,
                              width: selectedMaskRegion.width,
                              height: selectedMaskRegion.height
                            },
                            {
                              x: selectedMaskRegion.x,
                              y: selectedMaskRegion.y,
                              width: nextW,
                              height: selectedMaskRegion.height
                            }
                          );
                          updateMaskRegion(selectedMaskRegion.id, { width: nextW, polygon: poly });
                        }}
                      />
                    </label>
                    <label>H
                      <input
                        type="number"
                        className="mt-1 w-full rounded bg-[#141b2a] p-1"
                        min={1}
                        max={100}
                        step={0.1}
                        value={selectedMaskRegion.height}
                        onChange={(e) => {
                          const nextH = clamp(Number(e.target.value), 1, 100 - selectedMaskRegion.y);
                          const poly = transformPolygonByBox(
                            normalizePolygon(selectedMaskRegion.polygon),
                            {
                              x: selectedMaskRegion.x,
                              y: selectedMaskRegion.y,
                              width: selectedMaskRegion.width,
                              height: selectedMaskRegion.height
                            },
                            {
                              x: selectedMaskRegion.x,
                              y: selectedMaskRegion.y,
                              width: selectedMaskRegion.width,
                              height: nextH
                            }
                          );
                          updateMaskRegion(selectedMaskRegion.id, { height: nextH, polygon: poly });
                        }}
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="mt-2 max-h-28 space-y-1 overflow-auto">
                {currentPage.mask_regions.map((region) => (
                  <button
                    key={`mask-list-${region.id}`}
                    className={`w-full rounded px-2 py-1 text-left ${region.id === currentPage.selected_mask_region_id ? "bg-[#ff9d42]/25" : "bg-[#141b2a]"}`}
                    onClick={() => updateCurrentPage((page) => ({ ...page, selected_mask_region_id: region.id }))}
                  >
                    {region.id} • {region.label} • {Math.round(region.confidence * 100)}%
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg bg-[#121827] px-3 py-2"><span>Умная заливка</span><input type="checkbox" checked={smartFillEnabled} onChange={(e) => setSmartFillEnabled(e.target.checked)} /></label>
            {maskPreviewError ? <p className="text-amber-200">{maskPreviewError}</p> : null}
            {currentPage.pipeline_error ? <p className="text-red-300">{currentPage.pipeline_error}</p> : null}
          </div>,
          "left"
        )}

        {renderFloatingPanel(
          "text",
          "Текст",
          <div className="space-y-2 text-xs">
            <p className="rounded-lg bg-[#121827] p-2 text-[11px] text-white/75">Выбери сегмент в списке ниже и отредактируй перевод в текстовом поле. Изменения сохраняются автоматически.</p>
            <input className="w-full rounded-lg bg-[#141b2a] p-2" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Поиск сегмента" />
            <select className="w-full rounded-lg bg-[#141b2a] p-2" value={filterMode} onChange={(e) => setFilterMode(e.target.value as FilterMode)}>
              <option value="all">all</option>
              <option value="todo">todo</option>
              <option value="edited">edited</option>
              <option value="approved">approved</option>
              <option value="low_confidence">low confidence</option>
              <option value="empty">empty</option>
            </select>

            {selectedRegion ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label>X
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedRegion.x}
                      onChange={(e) => updateRegion(selectedRegion.id, { x: clamp(Number(e.target.value), 0, 100 - selectedRegion.width) })}
                    />
                  </label>
                  <label>Y
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedRegion.y}
                      onChange={(e) => updateRegion(selectedRegion.id, { y: clamp(Number(e.target.value), 0, 100 - selectedRegion.height) })}
                    />
                  </label>
                  <label>W
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                      min={1}
                      max={100}
                      step={0.1}
                      value={selectedRegion.width}
                      onChange={(e) => updateRegion(selectedRegion.id, { width: clamp(Number(e.target.value), 1, 100 - selectedRegion.x) })}
                    />
                  </label>
                  <label>H
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                      min={1}
                      max={100}
                      step={0.1}
                      value={selectedRegion.height}
                      onChange={(e) => updateRegion(selectedRegion.id, { height: clamp(Number(e.target.value), 1, 100 - selectedRegion.y) })}
                    />
                  </label>
                </div>
                <select className="w-full rounded-lg bg-[#141b2a] p-2" value={selectedRegion.font_family} onChange={(e) => updateRegion(selectedRegion.id, { font_family: e.target.value })}>
                  <option>Arial</option>
                  <option>Times New Roman</option>
                  <option>Verdana</option>
                  <option>Trebuchet MS</option>
                  <option>Impact</option>
                </select>
                <div className="grid grid-cols-3 gap-2">
                  <select className="rounded-lg bg-[#141b2a] p-2" value={selectedRegion.font_style} onChange={(e) => updateRegion(selectedRegion.id, { font_style: e.target.value as "normal" | "italic" })}>
                    <option value="normal">Обычный</option>
                    <option value="italic">Курсив</option>
                  </select>
                  <select className="rounded-lg bg-[#141b2a] p-2" value={selectedRegion.font_weight} onChange={(e) => updateRegion(selectedRegion.id, { font_weight: e.target.value as "400" | "600" | "700" })}>
                    <option value="400">400</option>
                    <option value="600">600</option>
                    <option value="700">700</option>
                  </select>
                  <select className="rounded-lg bg-[#141b2a] p-2" value={selectedRegion.font_size} onChange={(e) => updateRegion(selectedRegion.id, { font_size: Number(e.target.value) })}>
                    {[16, 20, 24, 28, 32, 36, 40, 48].map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-[56px_1fr] items-center gap-2"><input type="color" value={selectedRegion.text_color} onChange={(e) => updateRegion(selectedRegion.id, { text_color: e.target.value })} /><span>{selectedRegion.text_color}</span></div>
                <label>Прозрачность текста<input type="range" className="w-full" min={0} max={1} step={0.01} value={selectedRegion.text_opacity} onChange={(e) => updateRegion(selectedRegion.id, { text_opacity: Number(e.target.value) })} /></label>
                <label className="flex items-center justify-between rounded bg-[#141b2a] px-2 py-1">
                  <span>Обводка</span>
                  <input type="checkbox" checked={selectedRegion.outline_enabled} onChange={(e) => updateRegion(selectedRegion.id, { outline_enabled: e.target.checked })} />
                </label>
                <div className="grid grid-cols-[56px_1fr] items-center gap-2"><input type="color" value={selectedRegion.outline_color} onChange={(e) => updateRegion(selectedRegion.id, { outline_color: e.target.value })} /><span>{selectedRegion.outline_color}</span></div>
                <label>Толщина обводки<input type="range" className="w-full" min={0} max={8} step={1} value={selectedRegion.outline_width} onChange={(e) => updateRegion(selectedRegion.id, { outline_width: Number(e.target.value) })} /></label>
                <div className="grid grid-cols-[56px_1fr] items-center gap-2"><input type="color" value={selectedRegion.background_color} onChange={(e) => updateRegion(selectedRegion.id, { background_color: e.target.value })} /><span>{selectedRegion.background_color}</span></div>
                <label>Прозрачность фона<input type="range" className="w-full" min={0} max={1} step={0.01} value={selectedRegion.background_opacity} onChange={(e) => updateRegion(selectedRegion.id, { background_opacity: Number(e.target.value) })} /></label>
                <label>Блюр<input type="range" className="w-full" min={0} max={10} step={0.2} value={selectedRegion.background_blur} onChange={(e) => updateRegion(selectedRegion.id, { background_blur: Number(e.target.value) })} /></label>
                <textarea className="w-full rounded-lg bg-[#141b2a] p-2" rows={3} value={selectedRegion.translated_text} onChange={(e) => updateRegion(selectedRegion.id, { translated_text: e.target.value, review_status: e.target.value.trim() ? "edited" : selectedRegion.review_status })} />
                <button className="rounded-lg bg-red-500/30 px-2 py-2" onClick={deleteSelectedTextRegion}>Удалить текстовый блок</button>
              </>
            ) : (
              <p className="rounded-lg bg-[#141b2a] p-2">Выберите блок.</p>
            )}

            <div className="max-h-44 space-y-2 overflow-auto">
              {filteredRegions.map((region) => (
                <button key={region.id} className={`w-full rounded-lg p-2 text-left ${region.id === currentPage.selected_region_id ? "bg-[#ff9d42]/25" : "bg-[#141b2a]"}`} onClick={() => updateCurrentPage((page) => ({ ...page, selected_region_id: region.id }))}>
                  <div className="flex items-center justify-between"><span>{region.id}</span><span style={{ color: statusColor(region.review_status) }}>{region.review_status}</span></div>
                  <p className="truncate text-[11px] text-white/75">{region.translated_text || region.source_text || "(пусто)"}</p>
                </button>
              ))}
            </div>
          </div>,
          "right"
        )}
      </div>

      {finishModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="tool-window w-full max-w-2xl rounded-2xl p-5">
            <h3 className="text-2xl font-semibold">Подтверждение завершения</h3>
            <p className="mt-2 text-sm text-white/70">Выберите, что и как сохранить. После подтверждения начнется скачивание.</p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="rounded-lg bg-[#141b2a] p-3 text-sm">
                Область сохранения
                <select className="mt-2 w-full rounded-lg bg-black/25 p-2 text-sm" value={exportOptions.scope} onChange={(e) => setExportOptions((prev) => ({ ...prev, scope: e.target.value as "current" | "all" }))}>
                  <option value="current">Только текущая страница</option>
                  <option value="all">Все страницы</option>
                </select>
              </label>
              <label className="rounded-lg bg-[#141b2a] p-3 text-sm">
                Префикс имени файлов
                <input className="mt-2 w-full rounded-lg bg-black/25 p-2 text-sm" value={exportOptions.prefix} onChange={(e) => setExportOptions((prev) => ({ ...prev, prefix: e.target.value }))} />
              </label>
            </div>

            <div className="mt-4 grid gap-2 rounded-lg bg-[#141b2a] p-3 text-sm">
              <label className="flex items-center justify-between"><span>Скачать JSON</span><input type="checkbox" checked={exportOptions.export_json} onChange={(e) => setExportOptions((prev) => ({ ...prev, export_json: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>Скачать PNG</span><input type="checkbox" checked={exportOptions.export_png} onChange={(e) => setExportOptions((prev) => ({ ...prev, export_png: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>Скачать Project</span><input type="checkbox" checked={exportOptions.export_project} onChange={(e) => setExportOptions((prev) => ({ ...prev, export_project: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>Включать стиль в JSON</span><input type="checkbox" checked={exportOptions.include_styles} onChange={(e) => setExportOptions((prev) => ({ ...prev, include_styles: e.target.checked }))} /></label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded-lg bg-white/15 px-4 py-2" onClick={() => void onExportServerZip()}>
                ZIP (сервер)
              </button>
              <button className="rounded-lg bg-white/15 px-4 py-2" onClick={() => setFinishModalOpen(false)}>Отмена</button>
              <button className="rounded-lg bg-[#ff9d42] px-4 py-2 font-semibold text-black" onClick={() => void onConfirmFinish()}>Подтвердить</button>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-black/80 px-4 py-2 text-sm text-white">{notice}</div> : null}
      <div className="fixed bottom-4 left-4 z-40 rounded-lg bg-black/70 px-3 py-2 text-xs text-white/85 backdrop-blur">
        Режим: {effectiveToolMode === "select" ? "Мышка" : effectiveToolMode === "pan" ? "Рука" : "Лупа"} | Space: временная рука | Wheel: панорамирование | Ctrl/Cmd+Wheel: зум | Shift+Wheel: по X
      </div>
    </section>
  );
}
