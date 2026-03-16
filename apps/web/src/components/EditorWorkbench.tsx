"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  translateTexts,
  detectTextBoxes,
  runOcr,
  cleanImage,
} from "@/lib/api";
import { DetectedRegion, DetectRegion, MaskRegion, PipelineConfig, ProjectProgress, ProviderInfo, Point } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReviewStatus = "todo" | "edited" | "approved";
type FilterMode = "all" | "todo" | "edited" | "approved" | "low_confidence" | "empty";
type ToolMode = "select" | "pan" | "zoom";
type EditorMode = "manual" | "automatic";

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

type ImageMeta = { width: number; height: number };

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
  detect_regions: DetectRegion[];
  project_id: string | null;
  server_page_id: string | null;
  region_id_map: Record<string, string>;
  selected_region_id: string | null;
  selected_mask_region_id: string | null;
  latest_job_id: string | null;
  pipeline_status: "idle" | "running" | "done" | "error";
  pipeline_error: string | null;
};

type ExportOptions = { scope: "current" | "all"; export_json: boolean; export_png: boolean; export_project: boolean; include_styles: boolean; prefix: string };
type PanDragState = { startClientX: number; startClientY: number; startX: number; startY: number };
type RegionDragState = { kind: "text" | "mask"; mode: "move" | "resize"; id: string; startClientX: number; startClientY: number; startX: number; startY: number; startWidth: number; startHeight: number; startPolygon: Point[] | null; displayWidth: number; displayHeight: number };
type MaskControls = { inpaintBubbleExpandPx: number; inpaintTextExpandPx: number; inpaintBubbleScale: number; inpaintTextScale: number };

const DEFAULT_MASK_CONTROLS: MaskControls = { inpaintBubbleExpandPx: 8, inpaintTextExpandPx: 3, inpaintBubbleScale: 1.03, inpaintTextScale: 1 };
const DEFAULT_EXPORT_OPTIONS: ExportOptions = { scope: "all", export_json: true, export_png: true, export_project: true, include_styles: true, prefix: "mangaflow" };
const PIPELINE_POLL_MAX_ATTEMPTS = 600;
const PIPELINE_POLL_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }
function clampPercent(v: number) { return clamp(v, 0, 100); }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const n = c.length === 3 ? c.split("").map(x => x + x).join("") : c;
  const b = parseInt(n, 16);
  return `rgba(${(b >> 16) & 255}, ${(b >> 8) & 255}, ${b & 255}, ${alpha})`;
}

function normalizePolygon(polygon: Point[] | null | undefined): Point[] | null {
  if (!polygon || polygon.length < 3) return null;
  return polygon.map(pt => ({ x: Number(clampPercent(pt.x).toFixed(4)), y: Number(clampPercent(pt.y).toFixed(4)) }));
}

function transformPolygonByBox(polygon: Point[] | null, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }): Point[] | null {
  if (!polygon || polygon.length < 3) return null;
  const fw = Math.max(0.0001, from.width), fh = Math.max(0.0001, from.height);
  return normalizePolygon(polygon.map(pt => ({ x: to.x + ((pt.x - from.x) / fw) * to.width, y: to.y + ((pt.y - from.y) / fh) * to.height })));
}

function toEditorRegion(region: DetectedRegion): EditorRegion {
  return { ...region, review_status: region.translated_text?.trim() ? "edited" : "todo", note: "", font_family: "Arial", font_size: 24, font_style: "normal", font_weight: "600", text_color: "#000000", text_opacity: 1, outline_enabled: true, outline_color: "#ffffff", outline_width: 2, background_color: "#ffffff", background_opacity: 0, background_blur: 0 };
}

async function fileToDataURL(file: File): Promise<string> { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); }); }
async function imageMetaFromDataURL(dataUrl: string): Promise<ImageMeta> { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight }); img.onerror = reject; img.src = dataUrl; }); }
function downloadBlob(content: Blob, filename: string) { const url = URL.createObjectURL(content); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url); }
function downloadDataUrl(dataUrl: string, filename: string) { const a = document.createElement("a"); a.href = dataUrl; a.download = filename; a.click(); }
function statusColor(s: ReviewStatus): string { return s === "approved" ? "#22c55e" : s === "edited" ? "#38bdf8" : "#ff9d42"; }
function resolveProvider(e: string): "stub" | "huggingface" | "custom" { return e === "huggingface" ? "huggingface" : e === "custom" ? "custom" : "stub"; }

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return text ? [text] : [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) { const c = line ? `${line} ${word}` : word; if (ctx.measureText(c).width <= maxWidth || !line) { line = c; continue; } lines.push(line); line = word; }
  if (line) lines.push(line);
  return lines;
}

function drawFittedText(ctx: CanvasRenderingContext2D, text: string, opts: { x: number; y: number; width: number; height: number; fontFamily: string; fontStyle: "normal" | "italic"; fontWeight: "400" | "600" | "700"; preferredSize: number; outlineEnabled: boolean; outlineColor: string; outlineWidth: number }) {
  const { x, y, width, height, fontFamily, fontStyle, fontWeight, preferredSize, outlineEnabled, outlineColor, outlineWidth } = opts;
  if (!text.trim()) return;
  const pad = 6, maxW = Math.max(8, width - pad * 2), maxH = Math.max(8, height - pad * 2);
  let size = Math.max(10, Math.round(preferredSize));
  let chosenLines: string[] = [text];
  while (size >= 10) { ctx.font = `${fontStyle} ${fontWeight} ${size}px ${fontFamily}`; const lines = wrapTextLines(ctx, text, maxW); const lh = Math.max(12, Math.round(size * 1.16)); if (lines.length * lh <= maxH) { chosenLines = lines; break; } size -= 1; }
  ctx.font = `${fontStyle} ${fontWeight} ${Math.max(10, size)}px ${fontFamily}`;
  const lh = Math.max(12, Math.round(Math.max(10, size) * 1.16));
  chosenLines.forEach((line, idx) => { const lx = x + pad, ly = y + pad + idx * lh; if (outlineEnabled && outlineWidth > 0) { ctx.strokeStyle = outlineColor; ctx.lineJoin = "round"; ctx.lineWidth = Math.max(1, outlineWidth); ctx.strokeText(line, lx, ly, maxW); } ctx.fillText(line, lx, ly, maxW); });
}

async function renderPageToPng(page: PageDoc): Promise<string> {
  const image = new Image(); image.src = page.preview; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = page.image_meta.width; canvas.height = page.image_meta.height;
  const ctx = canvas.getContext("2d"); if (!ctx) return "";
  ctx.drawImage(image, 0, 0);
  for (const r of page.regions) {
    const x = (r.x / 100) * canvas.width, y = (r.y / 100) * canvas.height, w = (r.width / 100) * canvas.width, h = (r.height / 100) * canvas.height;
    if (r.background_opacity > 0) { ctx.fillStyle = hexToRgba(r.background_color, r.background_opacity); ctx.fillRect(x, y, w, h); }
    ctx.fillStyle = hexToRgba(r.text_color, r.text_opacity); ctx.textBaseline = "top";
    drawFittedText(ctx, r.translated_text || r.source_text || "", { x, y, width: w, height: h, fontFamily: r.font_family, fontStyle: r.font_style, fontWeight: r.font_weight, preferredSize: r.font_size, outlineEnabled: r.outline_enabled, outlineColor: r.outline_color, outlineWidth: r.outline_width });
  }
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditorWorkbench() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const saveTimersRef = useRef<Record<string, number>>({});

  // Core state
  const [stageSize, setStageSize] = useState({ width: 1, height: 1 });
  const [pages, setPages] = useState<PageDoc[]>([]);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [editorMode, setEditorMode] = useState<EditorMode>("automatic");
  const [targetLang, setTargetLang] = useState("ru");
  const [sourceLang, setSourceLang] = useState("ja");
  const [translatorEngine, setTranslatorEngine] = useState("custom");
  const [pipelineConfig, setPipelineConfig] = useState<PipelineConfig>({
    detector: { provider: "custom" }, inpainter: { provider: "custom" }, ocr: { provider: "custom" }, translator: { provider: "custom" },
  });
  const [providerCatalog, setProviderCatalog] = useState<ProviderInfo[]>([]);
  const [projectProgress, setProjectProgress] = useState<ProjectProgress | null>(null);

  // Text editing
  const [draftSourceText, setDraftSourceText] = useState("");
  const [draftTranslatedText, setDraftTranslatedText] = useState("");

  // Mask & pipeline loading
  const [maskControls, setMaskControls] = useState<MaskControls>(DEFAULT_MASK_CONTROLS);
  const [showMaskPreview, setShowMaskPreview] = useState(false);
  const [maskPreviewLoading, setMaskPreviewLoading] = useState(false);
  const [inpaintLoading, setInpaintLoading] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [stageLoading, setStageLoading] = useState<string | null>(null);
  const [maskPreviewError, setMaskPreviewError] = useState<string | null>(null);
  const [showOriginalImage, setShowOriginalImage] = useState(false);

  // View controls
  const [showRegions, setShowRegions] = useState(true);
  const [showText, setShowText] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchText, setSearchText] = useState("");
  const [zoomPercent, setZoomPercent] = useState(100);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [isSpacePanning, setIsSpacePanning] = useState(false);

  // Drag state
  const [regionDrag, setRegionDrag] = useState<RegionDragState | null>(null);
  const [panDrag, setPanDrag] = useState<PanDragState | null>(null);
  const [vertexDrag, setVertexDrag] = useState<{ regionId: string; vertexIndex: number; startClientX: number; startClientY: number; startPtX: number; startPtY: number; displayWidth: number; displayHeight: number } | null>(null);

  // Modals & notices
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [showMaskPanel, setShowMaskPanel] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const currentPage = pages[activePageIndex] ?? null;
  const effectiveToolMode: ToolMode = isSpacePanning ? "pan" : toolMode;
  const displayImageSrc = currentPage ? (showOriginalImage || !currentPage.processed_preview ? currentPage.original_preview : currentPage.preview) : "";

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      const key = "mangaflow_dev_user_id";
      const existing = window.localStorage.getItem(key);
      const userId = existing || `dev-user-${Math.random().toString(36).slice(2, 10)}`;
      if (!existing) window.localStorage.setItem(key, userId);
      let attempt = 0;
      while (!cancelled) {
        try { const t = await issueDevToken(userId); if (!cancelled) { setAuthToken(t); setNotice(null); } return; }
        catch { attempt++; if (!cancelled && attempt === 5) setNotice("JWT dev-token временно недоступен..."); await sleep(Math.min(5000, 600 + attempt * 500)); }
      }
    };
    void init();
    return () => { cancelled = true; };
  }, []);

  // ---------------------------------------------------------------------------
  // Load providers
  // ---------------------------------------------------------------------------
  useEffect(() => { let c = false; void fetchProviders().then(p => { if (!c) setProviderCatalog(p); }).catch(() => {}); return () => { c = true; }; }, []);

  // ---------------------------------------------------------------------------
  // Session restore
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!authToken || restored) return;
    if (pages.length > 0) { setRestored(true); return; }
    const restore = async () => {
      try {
        let session = await fetchLastSession(authToken);
        if (!session.project_id || !session.page_id) {
          const raw = window.localStorage.getItem("mangaflow_last_session");
          if (raw) { try { session = JSON.parse(raw); } catch { window.localStorage.removeItem("mangaflow_last_session"); } }
        }
        if (!session.project_id || !session.page_id) { setRestored(true); return; }
        const inputBlob = await fetchPageInput({ projectId: session.project_id as string, pageId: session.page_id as string }, authToken);
        let previewBlob: Blob = inputBlob;
        try { previewBlob = await fetchPagePreview({ projectId: session.project_id as string, pageId: session.page_id as string }, authToken); } catch {}
        const fileName = session.file_name || "restored.png";
        const file = new File([inputBlob], fileName, { type: inputBlob.type || "image/png" });
        const originalPreview = await fileToDataURL(file);
        const previewFile = new File([previewBlob], `preview-${fileName}`, { type: previewBlob.type || "image/png" });
        const preview = await fileToDataURL(previewFile);
        const image_meta = await imageMetaFromDataURL(preview);
        const serverRegions = await fetchPageRegions({ projectId: session.project_id as string, pageId: session.page_id as string }, authToken);
        const mapped = serverRegions.map(r => toEditorRegion({ id: r.external_region_id, x: r.x, y: r.y, width: r.width, height: r.height, source_text: r.source_text, translated_text: r.translated_text, confidence: r.confidence }));
        const regionMap = serverRegions.reduce<Record<string, string>>((acc, r) => { acc[r.external_region_id] = r.id; return acc; }, {});
        setPages([{ id: `page-${Date.now()}`, file, file_name: file.name, original_preview: originalPreview, preview, processed_preview: preview !== originalPreview ? preview : null, image_meta, regions: mapped, mask_regions: [], detect_regions: [], project_id: session.project_id as string, server_page_id: session.page_id as string, region_id_map: regionMap, selected_region_id: mapped[0]?.id ?? null, selected_mask_region_id: null, latest_job_id: null, pipeline_status: "done", pipeline_error: null }]);
        setDraftSourceText(mapped[0]?.source_text ?? ""); setDraftTranslatedText(mapped[0]?.translated_text ?? "");
        const view = (session.view_params || {}) as Record<string, unknown>;
        const zoom = Number(view.zoom_percent ?? NaN); if (Number.isFinite(zoom)) setZoomPercent(clamp(zoom, 40, 600));
        setNotice("Сессия восстановлена.");
      } catch { setNotice("Не удалось восстановить последнюю сессию."); } finally { setRestored(true); }
    };
    void restore();
  }, [authToken, restored, pages.length]);

  // ---------------------------------------------------------------------------
  // Computed values
  // ---------------------------------------------------------------------------
  const selectedRegion = useMemo(() => currentPage?.regions.find(r => r.id === currentPage.selected_region_id) ?? null, [currentPage]);
  const selectedMaskRegion = useMemo(() => currentPage?.mask_regions.find(r => r.id === currentPage.selected_mask_region_id) ?? null, [currentPage]);
  const quality = useMemo(() => { if (!currentPage) return { total: 0, approved: 0, progress: 0 }; const t = currentPage.regions.length, a = currentPage.regions.filter(r => r.review_status === "approved").length; return { total: t, approved: a, progress: t ? Math.round((a / t) * 100) : 0 }; }, [currentPage]);

  const filteredRegions = useMemo(() => {
    if (!currentPage) return [];
    const q = searchText.trim().toLowerCase();
    return currentPage.regions.filter(r => {
      if (filterMode === "todo" && r.review_status !== "todo") return false;
      if (filterMode === "edited" && r.review_status !== "edited") return false;
      if (filterMode === "approved" && r.review_status !== "approved") return false;
      if (filterMode === "low_confidence" && r.confidence >= 0.9) return false;
      if (filterMode === "empty" && r.translated_text.trim()) return false;
      if (!q) return true;
      return `${r.id} ${r.source_text} ${r.translated_text} ${r.note}`.toLowerCase().includes(q);
    });
  }, [currentPage, filterMode, searchText]);

  const displayedRect = useMemo(() => {
    if (!currentPage) return { width: 1, height: 1, x: 0, y: 0, scale: 1 };
    const pad = 8, maxW = Math.max(100, stageSize.width - pad * 2), maxH = Math.max(100, stageSize.height - pad * 2);
    const fitScale = Math.min(maxW / currentPage.image_meta.width, maxH / currentPage.image_meta.height);
    const scale = fitScale * (zoomPercent / 100);
    const w = Math.round(currentPage.image_meta.width * scale), h = Math.round(currentPage.image_meta.height * scale);
    return { width: w, height: h, x: Math.round((stageSize.width - w) / 2), y: Math.round((stageSize.height - h) / 2), scale };
  }, [currentPage, stageSize, zoomPercent]);

  useEffect(() => { if (!selectedRegion) return; setDraftSourceText(selectedRegion.source_text); setDraftTranslatedText(selectedRegion.translated_text); }, [selectedRegion?.id]);

  // ---------------------------------------------------------------------------
  // Resize observer + keyboard
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const sync = () => { const r = el.getBoundingClientRect(); setStageSize({ width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }); };
    sync(); const obs = new ResizeObserver(sync); obs.observe(el); window.addEventListener("resize", sync);
    return () => { window.removeEventListener("resize", sync); obs.disconnect(); };
  }, [currentPage?.id]);

  useEffect(() => {
    const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; if (!el) return false; const tag = el.tagName?.toLowerCase(); return tag === "input" || tag === "textarea" || el.isContentEditable; };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTyping(e.target)) {
        if (e.code === "Space") { e.preventDefault(); setIsSpacePanning(true); }
        if (e.key.toLowerCase() === "v") setToolMode("select");
        if (e.key.toLowerCase() === "h") setToolMode("pan");
        if (e.key.toLowerCase() === "z") setToolMode("zoom");
        if (e.key === "Delete" || e.key === "Backspace") {
          setPages(cur => cur.map((p, i) => {
            if (i !== activePageIndex) return p;
            if (p.selected_region_id) {
              const nr = p.regions.filter(r => r.id !== p.selected_region_id);
              return { ...p, regions: nr, selected_region_id: nr[0]?.id ?? null };
            }
            if (p.selected_mask_region_id) {
              return { ...p, mask_regions: p.mask_regions.filter(r => r.id !== p.selected_mask_region_id), detect_regions: p.detect_regions.filter(r => r.id !== p.selected_mask_region_id), selected_mask_region_id: null };
            }
            return p;
          }));
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === "Space") { setIsSpacePanning(false); setPanDrag(null); } };
    window.addEventListener("keydown", onKeyDown); window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  useEffect(() => { setPanOffset({ x: 0, y: 0 }); }, [currentPage?.id]);

  // ---------------------------------------------------------------------------
  // Session persist + progress polling
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!authToken || !currentPage?.project_id || !currentPage?.server_page_id) return;
    const t = window.setTimeout(() => { void upsertLastSession({ project_id: currentPage.project_id, page_id: currentPage.server_page_id, file_name: currentPage.file_name, view_params: { zoom_percent: zoomPercent, pan_x: panOffset.x, pan_y: panOffset.y, show_original: showOriginalImage } }, authToken).catch(() => {}); }, 250);
    return () => window.clearTimeout(t);
  }, [authToken, currentPage?.project_id, currentPage?.server_page_id, zoomPercent, panOffset.x, panOffset.y, showOriginalImage]);

  useEffect(() => {
    if (!authToken || !currentPage?.project_id) return;
    let c = false;
    const pull = async () => { try { const p = await fetchProjectProgress(currentPage.project_id as string, authToken); if (!c) setProjectProgress(p); } catch { if (!c) setProjectProgress(null); } };
    void pull(); const iv = window.setInterval(() => void pull(), 3000);
    return () => { c = true; window.clearInterval(iv); };
  }, [authToken, currentPage?.project_id]);

  // ---------------------------------------------------------------------------
  // Local persistence for manual stage results
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!currentPage || !currentPage.file_name) return;
    const key = `mangaflow_manual_${currentPage.file_name}`;
    const data = {
      ts: Date.now(),
      detect_regions: currentPage.detect_regions,
      mask_regions: currentPage.mask_regions,
      regions: currentPage.regions,
      preview: currentPage.processed_preview,
    };
    try { window.localStorage.setItem(key, JSON.stringify(data)); } catch {}
  }, [currentPage?.detect_regions, currentPage?.mask_regions, currentPage?.regions, currentPage?.processed_preview, currentPage?.file_name]);

  // Restore manual results on file upload (if same filename found)
  const restoreManualResults = useCallback((fileName: string, page: PageDoc): PageDoc => {
    const key = `mangaflow_manual_${fileName}`;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return page;
      const data = JSON.parse(raw);
      if (Date.now() - data.ts > 24 * 60 * 60 * 1000) { window.localStorage.removeItem(key); return page; }
      return {
        ...page,
        detect_regions: data.detect_regions || [],
        mask_regions: data.mask_regions || [],
        regions: (data.regions || []).map((r: DetectedRegion) => toEditorRegion(r)),
        processed_preview: data.preview || null,
        selected_region_id: data.regions?.[0]?.id ?? null,
        selected_mask_region_id: data.mask_regions?.[0]?.id ?? null,
      };
    } catch { return page; }
  }, []);

  // ---------------------------------------------------------------------------
  // Drag handling
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (regionDrag && currentPage && effectiveToolMode === "select") {
        const dx = (e.clientX - regionDrag.startClientX) / regionDrag.displayWidth * 100;
        const dy = (e.clientY - regionDrag.startClientY) / regionDrag.displayHeight * 100;
        setPages(cur => cur.map((p, i) => {
          if (i !== activePageIndex) return p;
          if (regionDrag.kind === "text") {
            return { ...p, regions: p.regions.map(r => { if (r.id !== regionDrag.id) return r; if (regionDrag.mode === "move") return { ...r, x: Number(clamp(regionDrag.startX + dx, 0, 100 - r.width).toFixed(3)), y: Number(clamp(regionDrag.startY + dy, 0, 100 - r.height).toFixed(3)) }; return { ...r, width: Number(clamp(regionDrag.startWidth + dx, 1, 100 - r.x).toFixed(3)), height: Number(clamp(regionDrag.startHeight + dy, 1, 100 - r.y).toFixed(3)) }; }) };
          }
          return { ...p, mask_regions: p.mask_regions.map(r => {
            if (r.id !== regionDrag.id) return r;
            let nx = r.x, ny = r.y, nw = r.width, nh = r.height;
            if (regionDrag.mode === "move") { nx = clamp(regionDrag.startX + dx, 0, 100 - r.width); ny = clamp(regionDrag.startY + dy, 0, 100 - r.height); } else { nw = clamp(regionDrag.startWidth + dx, 1, 100 - r.x); nh = clamp(regionDrag.startHeight + dy, 1, 100 - r.y); }
            const next: MaskRegion = { ...r, x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)), width: Number(nw.toFixed(3)), height: Number(nh.toFixed(3)) };
            const poly = transformPolygonByBox(regionDrag.startPolygon, { x: regionDrag.startX, y: regionDrag.startY, width: regionDrag.startWidth, height: regionDrag.startHeight }, { x: next.x, y: next.y, width: next.width, height: next.height });
            if (poly) next.polygon = poly;
            return next;
          }) };
        }));
      }
      if (panDrag && effectiveToolMode === "pan") { setPanOffset({ x: panDrag.startX + e.clientX - panDrag.startClientX, y: panDrag.startY + e.clientY - panDrag.startClientY }); }
      if (vertexDrag) {
        const vdx = (e.clientX - vertexDrag.startClientX) / vertexDrag.displayWidth * 100;
        const vdy = (e.clientY - vertexDrag.startClientY) / vertexDrag.displayHeight * 100;
        const newX = clamp(vertexDrag.startPtX + vdx, 0, 100);
        const newY = clamp(vertexDrag.startPtY + vdy, 0, 100);
        setPages(cur => cur.map((p, i) => {
          if (i !== activePageIndex) return p;
          return { ...p, mask_regions: p.mask_regions.map(r => {
            if (r.id !== vertexDrag.regionId || !r.polygon) return r;
            const newPoly = r.polygon.map((pt, vi) => vi === vertexDrag.vertexIndex ? { x: Number(newX.toFixed(4)), y: Number(newY.toFixed(4)) } : pt);
            const xs = newPoly.map(pt => pt.x); const ys = newPoly.map(pt => pt.y);
            return { ...r, polygon: newPoly, x: Number(Math.min(...xs).toFixed(3)), y: Number(Math.min(...ys).toFixed(3)), width: Number((Math.max(...xs) - Math.min(...xs)).toFixed(3)), height: Number((Math.max(...ys) - Math.min(...ys)).toFixed(3)) };
          }) };
        }));
      }
    };
    const onMouseUp = () => {
      if (regionDrag && currentPage && regionDrag.kind === "text") { const r = currentPage.regions.find(x => x.id === regionDrag.id); if (r) scheduleRegionAutosave(currentPage, r.id, { x: r.x, y: r.y, width: r.width, height: r.height }); }
      setRegionDrag(null); setPanDrag(null); setVertexDrag(null);
    };
    window.addEventListener("mousemove", onMouseMove); window.addEventListener("mouseup", onMouseUp);
    return () => { window.removeEventListener("mousemove", onMouseMove); window.removeEventListener("mouseup", onMouseUp); };
  }, [regionDrag, panDrag, vertexDrag, currentPage, activePageIndex, effectiveToolMode, authToken]);

  // ---------------------------------------------------------------------------
  // Wheel zoom/pan
  // ---------------------------------------------------------------------------
  const zoomAtPoint = useCallback((clientX: number, clientY: number, delta: number) => {
    if (!stageRef.current) return;
    const next = clamp(zoomPercent + delta, 40, 600); if (next === zoomPercent) return;
    const sr = stageRef.current.getBoundingClientRect();
    const px = clientX - sr.left, py = clientY - sr.top;
    const cl = displayedRect.x + panOffset.x, ct = displayedRect.y + panOffset.y;
    const ax = (px - cl) / Math.max(1, displayedRect.width), ay = (py - ct) / Math.max(1, displayedRect.height);
    const f = next / zoomPercent, nw = displayedRect.width * f, nh = displayedRect.height * f;
    const ncx = (stageSize.width - nw) / 2, ncy = (stageSize.height - nh) / 2;
    setZoomPercent(next); setPanOffset({ x: px - ax * nw - ncx, y: py - ay * nh - ncy });
  }, [zoomPercent, panOffset, displayedRect, stageSize]);

  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (effectiveToolMode === "zoom" || e.ctrlKey || e.metaKey) { zoomAtPoint(e.clientX, e.clientY, e.deltaY < 0 ? 10 : -10); return; }
      const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const f = 1.15;
      setPanOffset(p => ({ x: horiz ? p.x - e.deltaY * f : p.x - e.deltaX * f, y: horiz ? p.y : p.y - e.deltaY * f }));
    };
    el.addEventListener("wheel", handler, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", handler, { capture: true } as EventListenerOptions);
  }, [effectiveToolMode, zoomAtPoint]);

  // ---------------------------------------------------------------------------
  // Page & region CRUD
  // ---------------------------------------------------------------------------
  const updateCurrentPage = (updater: (page: PageDoc) => PageDoc) => setPages(cur => cur.map((p, i) => i === activePageIndex ? updater(p) : p));

  const scheduleRegionAutosave = (page: PageDoc, regionId: string, patch: Record<string, unknown>) => {
    if (!authToken || !page.project_id || !page.server_page_id) return;
    const sid = page.region_id_map[regionId]; if (!sid || !Object.keys(patch).length) return;
    const key = `${page.server_page_id}:${sid}`;
    if (saveTimersRef.current[key]) window.clearTimeout(saveTimersRef.current[key]);
    saveTimersRef.current[key] = window.setTimeout(() => { void patchRegion({ projectId: page.project_id as string, pageId: page.server_page_id as string, regionId: sid, patch: patch as Partial<{ translated_text: string; review_status: ReviewStatus; x: number; y: number; width: number; height: number }> }, authToken).catch(() => setNotice("Автосохранение не удалось.")); }, 350);
  };

  const updateRegion = (id: string, patch: Partial<EditorRegion>) => {
    const snap = currentPage;
    updateCurrentPage(p => ({ ...p, regions: p.regions.map(r => { if (r.id !== id) return r; const n = { ...r, ...patch }; if (patch.translated_text !== undefined && n.review_status === "todo" && patch.translated_text.trim()) n.review_status = "edited"; return n; }) }));
    if (snap) { const sp: Record<string, unknown> = {}; if (patch.translated_text !== undefined) sp.translated_text = patch.translated_text; if (patch.review_status !== undefined) sp.review_status = patch.review_status; if (patch.x !== undefined) sp.x = patch.x; if (patch.y !== undefined) sp.y = patch.y; if (patch.width !== undefined) sp.width = patch.width; if (patch.height !== undefined) sp.height = patch.height; scheduleRegionAutosave(snap, id, sp); }
  };

  const updateMaskRegion = (id: string, patch: Partial<MaskRegion>) => {
    updateCurrentPage(p => ({ ...p, mask_regions: p.mask_regions.map(r => { if (r.id !== id) return r; const n: MaskRegion = { ...r, ...patch }; if (patch.polygon !== undefined) n.polygon = normalizePolygon(patch.polygon); return n; }) }));
  };

  const onPickFiles = async (filesList: FileList | null) => {
    if (!filesList) return;
    const files = Array.from(filesList).filter(f => f.type.startsWith("image/"));
    const loaded: PageDoc[] = [];
    for (const file of files) { const preview = await fileToDataURL(file); const meta = await imageMetaFromDataURL(preview); let page: PageDoc = { id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file, file_name: file.name, original_preview: preview, preview, processed_preview: null, image_meta: meta, regions: [], mask_regions: [], detect_regions: [], project_id: null, server_page_id: null, region_id_map: {}, selected_region_id: null, selected_mask_region_id: null, latest_job_id: null, pipeline_status: "idle", pipeline_error: null }; page = restoreManualResults(file.name, page); loaded.push(page); }
    setPages(cur => [...cur, ...loaded]);
    if (!currentPage) setActivePageIndex(0);
  };

  // ---------------------------------------------------------------------------
  // Manual stage handlers
  // ---------------------------------------------------------------------------
  const handleDetect = async () => {
    if (!currentPage) return;
    setStageLoading("detect");
    try {
      const resp = await detectTextBoxes(currentPage.file, pipelineConfig.detector?.provider || "custom");
      updateCurrentPage(p => ({ ...p, detect_regions: resp.regions, mask_regions: resp.regions.map(r => ({ id: r.id, label: (r.label === "bubble" ? "bubble" : "text") as "bubble" | "text", x: r.x, y: r.y, width: r.width, height: r.height, confidence: r.confidence, polygon: r.polygon })), selected_mask_region_id: resp.regions[0]?.id ?? null }));
      setShowMaskPreview(true); setShowOriginalImage(true);
      setNotice(`Обнаружено регионов: ${resp.regions.length}`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Detect failed"); } finally { setStageLoading(null); }
  };

  const handleOcr = async () => {
    if (!currentPage || !currentPage.detect_regions.length) { setNotice("Сначала запустите детекцию."); return; }
    setStageLoading("ocr");
    try {
      const resp = await runOcr(currentPage.file, currentPage.detect_regions, pipelineConfig.ocr?.provider || "custom");
      const regions = currentPage.detect_regions.map((dr, i) => toEditorRegion({ id: dr.id, x: dr.x, y: dr.y, width: dr.width, height: dr.height, source_text: resp.texts[i] || "", translated_text: "", confidence: dr.confidence, label: dr.label }));
      updateCurrentPage(p => ({ ...p, regions, selected_region_id: regions[0]?.id ?? null }));
      setShowMaskPreview(false);
      if (regions[0]) { setDraftSourceText(regions[0].source_text); setDraftTranslatedText(""); }
      setNotice("OCR завершен.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "OCR failed"); } finally { setStageLoading(null); }
  };

  const handleTranslate = async () => {
    if (!currentPage || !currentPage.regions.length) { setNotice("Сначала запустите OCR."); return; }
    setStageLoading("translate"); setTranslationLoading(true);
    try {
      const texts = currentPage.regions.map(r => r.source_text || "");
      const translated = await translateTexts({ provider: resolveProvider(translatorEngine), targetLang, texts });
      updateCurrentPage(p => ({ ...p, regions: p.regions.map((r, i) => { const t = translated[i] ?? ""; return { ...r, translated_text: t, review_status: r.review_status === "approved" ? "approved" : t.trim() ? "edited" : r.review_status }; }) }));
      setNotice("Перевод завершен.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Translation failed"); } finally { setStageLoading(null); setTranslationLoading(false); }
  };

  const handleClean = async () => {
    if (!currentPage || !currentPage.mask_regions.length) { setNotice("Сначала постройте маску."); return; }
    setStageLoading("clean"); setInpaintLoading(true);
    try {
      const resp = await cleanImage(currentPage.file, currentPage.mask_regions, pipelineConfig.inpainter?.provider || "custom");
      const dataUrl = `data:image/png;base64,${resp.inpainted_b64}`;
      const meta = await imageMetaFromDataURL(dataUrl);
      updateCurrentPage(p => ({ ...p, preview: dataUrl, processed_preview: dataUrl, image_meta: meta }));
      setShowOriginalImage(false); setNotice("Заливка применена.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Clean failed"); } finally { setStageLoading(null); setInpaintLoading(false); }
  };

  const handleRender = async () => {
    if (!currentPage) return;
    setStageLoading("render");
    try {
      const dataUrl = await renderPageToPng(currentPage);
      if (dataUrl) downloadDataUrl(dataUrl, `render-${currentPage.file_name.replace(/\.[^.]+$/, "")}.png`);
      setNotice("Рендер завершен.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Render failed"); } finally { setStageLoading(null); }
  };

  // ---------------------------------------------------------------------------
  // Automatic pipeline
  // ---------------------------------------------------------------------------
  const runAutoPipeline = async () => {
    if (!currentPage || !authToken) { setNotice("API не готова."); return; }
    updateCurrentPage(p => ({ ...p, pipeline_status: "running", pipeline_error: null }));
    try {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = await createPipelineJob({ file: currentPage.file, targetLang, provider: (pipelineConfig.detector?.provider as "stub" | "huggingface" | "custom") || "custom", requestId, projectId: currentPage.project_id ?? undefined, projectName: currentPage.file_name.replace(/\.[a-z0-9]+$/i, ""), pipelineConfig, inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx, inpaintTextExpandPx: maskControls.inpaintTextExpandPx, inpaintBubbleScale: maskControls.inpaintBubbleScale, inpaintTextScale: maskControls.inpaintTextScale }, authToken);
      updateCurrentPage(p => ({ ...p, latest_job_id: created.job_id }));
      let done = false;
      for (let i = 0; i < PIPELINE_POLL_MAX_ATTEMPTS; i++) {
        const s = await fetchPipelineJob(created.job_id, authToken);
        if (s.status === "done") {
          const sr = await fetchPageRegions({ projectId: created.project_id, pageId: created.page_id }, authToken);
          const mapped = sr.map(r => toEditorRegion({ id: r.external_region_id, x: r.x, y: r.y, width: r.width, height: r.height, source_text: r.source_text, translated_text: r.translated_text, confidence: r.confidence }));
          const regionMap = sr.reduce<Record<string, string>>((a, r) => { a[r.external_region_id] = r.id; return a; }, {});
          let maskRegions: MaskRegion[] = [];
          try { const mr = await previewMask({ file: currentPage.file, provider: "custom", ...maskControls }); maskRegions = mr.regions; } catch {}
          updateCurrentPage(p => ({ ...p, preview: p.original_preview, processed_preview: null, mask_regions: maskRegions, project_id: created.project_id, server_page_id: created.page_id, region_id_map: regionMap, regions: mapped, detect_regions: [], selected_region_id: mapped[0]?.id ?? null, selected_mask_region_id: maskRegions[0]?.id ?? null, latest_job_id: created.job_id, pipeline_status: "done", pipeline_error: null }));
          window.localStorage.setItem("mangaflow_last_session", JSON.stringify({ project_id: created.project_id, page_id: created.page_id, file_name: currentPage.file_name }));
          setDraftSourceText(mapped[0]?.source_text ?? ""); setDraftTranslatedText(mapped[0]?.translated_text ?? "");
          setShowMaskPreview(maskRegions.length > 0); setShowOriginalImage(true);
          setNotice("Pipeline завершен."); done = true; break;
        }
        if (s.status === "failed" || s.status === "canceled") throw new Error(s.error_message || "Pipeline failed");
        await sleep(PIPELINE_POLL_INTERVAL_MS);
      }
      if (!done) throw new Error("Pipeline timeout.");
    } catch (e) { updateCurrentPage(p => ({ ...p, pipeline_status: "error", pipeline_error: e instanceof Error ? e.message : "Pipeline error" })); }
  };

  // ---------------------------------------------------------------------------
  // Other actions
  // ---------------------------------------------------------------------------
  const translateCurrentDraft = async () => { if (!draftSourceText.trim()) { setDraftTranslatedText(""); return; } setTranslationLoading(true); try { const r = await translateTexts({ provider: resolveProvider(translatorEngine), targetLang, texts: [draftSourceText.trim()] }); setDraftTranslatedText(r[0] ?? ""); } catch (e) { setNotice(e instanceof Error ? e.message : "Ошибка перевода."); } finally { setTranslationLoading(false); } };
  const insertDraftToSelected = () => { if (!selectedRegion) return; updateRegion(selectedRegion.id, { source_text: draftSourceText, translated_text: draftTranslatedText, review_status: draftTranslatedText.trim() ? "edited" : selectedRegion.review_status }); };
  const cancelCurrentJob = async () => { if (!authToken || !currentPage?.latest_job_id) return; try { const r = await cancelPipelineJob(currentPage.latest_job_id, authToken); updateCurrentPage(p => ({ ...p, pipeline_status: r.status === "canceled" ? "error" : p.pipeline_status, pipeline_error: r.status === "canceled" ? "Отменено." : p.pipeline_error })); setNotice(`Статус: ${r.status}`); } catch (e) { setNotice(e instanceof Error ? e.message : "Отмена не удалась."); } };
  const previewMaskForCurrent = async () => { if (!currentPage) return; setMaskPreviewLoading(true); setMaskPreviewError(null); try { const r = await previewMask({ file: currentPage.file, provider: "custom", ...maskControls }); updateCurrentPage(p => ({ ...p, mask_regions: r.regions, selected_mask_region_id: r.regions[0]?.id ?? null })); setShowMaskPreview(true); setShowOriginalImage(true); } catch (e) { setMaskPreviewError(e instanceof Error ? e.message : "Mask error"); } finally { setMaskPreviewLoading(false); } };
  const applyInpaint = async () => { if (!currentPage?.mask_regions.length) { setNotice("Сначала постройте маску."); return; } setInpaintLoading(true); try { const blob = await previewInpaint({ file: currentPage.file, regions: currentPage.mask_regions }); const f = new File([blob], `inpaint-${currentPage.file_name}`, { type: blob.type || "image/png" }); const du = await fileToDataURL(f); const m = await imageMetaFromDataURL(du); updateCurrentPage(p => ({ ...p, preview: du, processed_preview: du, image_meta: m })); setShowOriginalImage(false); setNotice("Заливка применена."); } catch (e) { setMaskPreviewError(e instanceof Error ? e.message : "Inpaint error"); } finally { setInpaintLoading(false); } };

  const onConfirmFinish = async () => {
    if (!currentPage) return;
    const sp = exportOptions.scope === "all" ? pages : [currentPage];
    const pfx = exportOptions.prefix.trim() || "mangaflow";
    if (exportOptions.export_json) for (const p of sp) downloadBlob(new Blob([JSON.stringify({ file_name: p.file_name, target_lang: targetLang, regions: exportOptions.include_styles ? p.regions : p.regions.map(({ id, x, y, width, height, source_text, translated_text, confidence }) => ({ id, x, y, width, height, source_text, translated_text, confidence })) }, null, 2)], { type: "application/json" }), `${pfx}-${p.file_name}.json`);
    if (exportOptions.export_png) for (const p of sp) { const du = await renderPageToPng(p); if (du) downloadDataUrl(du, `${pfx}-${p.file_name.replace(/\.[^.]+$/, "")}.png`); }
    if (exportOptions.export_project) downloadBlob(new Blob([JSON.stringify({ project_name: pfx, created_at: new Date().toISOString(), target_lang: targetLang, pages: sp.map(p => ({ id: p.id, file_name: p.file_name, image_meta: p.image_meta, regions: p.regions })) }, null, 2)], { type: "application/json" }), `${pfx}-project.json`);
    setFinishModalOpen(false); setNotice("Экспорт запущен.");
  };

  const onExportServerZip = async () => { if (!authToken || !currentPage?.project_id) { setNotice("ZIP доступен только для сохраненного проекта."); return; } try { const blob = await exportProjectZip(currentPage.project_id, authToken); downloadBlob(blob, `${currentPage.file_name.replace(/\.[^.]+$/, "")}-export.zip`); } catch (e) { setNotice(e instanceof Error ? e.message : "Не удалось экспортировать ZIP."); } };

  // ---------------------------------------------------------------------------
  // Render: Upload screen
  // ---------------------------------------------------------------------------
  if (!currentPage) {
    return (
      <section className="flex h-screen items-center justify-center">
        <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0b0f18] p-10 text-center">
          <h2 className="text-2xl font-semibold">Manga<span className="text-[#ff9d42]">Flow</span></h2>
          <p className="mt-3 text-sm text-white/60">Загрузите страницы манги для перевода</p>
          <div className="mt-6 rounded-xl border border-dashed border-white/25 bg-black/25 p-8">
            <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => void onPickFiles(e.target.files)} />
            <button className="rounded-lg bg-[#ff9d42] px-6 py-3 font-semibold text-black" onClick={() => inputRef.current?.click()}>Выбрать файлы</button>
            <p className="mt-3 text-xs text-white/50">PNG / JPEG / WEBP · несколько файлов сразу</p>
          </div>
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Main editor
  // ---------------------------------------------------------------------------
  const stageBtn = (label: string, key: string, handler: () => void, disabled?: boolean) => (
    <button key={key} className={`rounded px-3 py-1.5 text-xs font-medium transition ${stageLoading === key ? "bg-[#ff9d42] text-black animate-pulse" : "bg-white/10 hover:bg-white/20 text-white"} disabled:opacity-40`} disabled={disabled || !!stageLoading || currentPage.pipeline_status === "running"} onClick={handler}>{stageLoading === key ? `${label}...` : label}</button>
  );

  return (
    <section className="flex h-screen flex-col">
      {/* ---- TOOLBAR ---- */}
      <div className="canvas-hud flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-white/90">
        <a href="/" className="mr-1 text-sm font-semibold tracking-tight hover:opacity-80 transition">Manga<span className="text-[#ff9d42]">Flow</span></a>
        <div className="h-4 w-px bg-white/20" />
        {/* Mode toggle */}
        <div className="flex items-center gap-1 rounded bg-white/10 p-0.5">
          <button className={`rounded px-2.5 py-1 ${editorMode === "manual" ? "bg-[#ff9d42] text-black" : ""}`} onClick={() => setEditorMode("manual")}>Manual</button>
          <button className={`rounded px-2.5 py-1 ${editorMode === "automatic" ? "bg-[#ff9d42] text-black" : ""}`} onClick={() => setEditorMode("automatic")}>Auto</button>
        </div>
        <div className="h-4 w-px bg-white/20" />

        {editorMode === "manual" ? (
          <>
            {stageBtn("Detect", "detect", handleDetect)}
            {stageBtn("OCR", "ocr", handleOcr, !currentPage.detect_regions.length)}
            {stageBtn("Translate", "translate", handleTranslate, !currentPage.regions.length)}
            {stageBtn("Clean", "clean", handleClean, !currentPage.mask_regions.length)}
            {stageBtn("Render", "render", handleRender, !currentPage.regions.length)}
          </>
        ) : (
          <>
            <button className="rounded bg-[#ff9d42] px-4 py-1.5 text-xs font-semibold text-black disabled:opacity-40" disabled={currentPage.pipeline_status === "running" || !authToken} onClick={() => void runAutoPipeline()}>
              {currentPage.pipeline_status === "running" ? "Processing..." : "Translate"}
            </button>
            <button className="rounded bg-white/10 px-3 py-1.5 text-xs" onClick={() => void cancelCurrentJob()} disabled={!currentPage.latest_job_id}>Cancel</button>
          </>
        )}

        <div className="h-4 w-px bg-white/20" />
        {/* Zoom */}
        <div className="flex items-center gap-1">
          {(["select", "pan", "zoom"] as ToolMode[]).map(m => (
            <button key={m} className={`rounded px-2 py-1 ${toolMode === m ? "bg-[#ff9d42] text-black" : "bg-white/10"}`} onClick={() => setToolMode(m)}>
              {m === "select" ? "V" : m === "pan" ? "H" : "Z"}
            </button>
          ))}
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => setZoomPercent(v => clamp(v - 10, 40, 600))}>-</button>
          <span className="w-10 text-center">{zoomPercent}%</span>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => setZoomPercent(v => clamp(v + 10, 40, 600))}>+</button>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => { setZoomPercent(100); setPanOffset({ x: 0, y: 0 }); }}>Fit</button>
        </div>
        <div className="h-4 w-px bg-white/20" />
        <label className="flex items-center gap-1"><input type="checkbox" checked={showRegions} onChange={e => setShowRegions(e.target.checked)} />Regions</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)} />Text</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />Grid</label>
        <button className="rounded bg-white/10 px-2 py-1 disabled:opacity-40" onClick={() => setShowOriginalImage(p => !p)} disabled={!currentPage.processed_preview}>{showOriginalImage ? "After" : "Before"}</button>
        <div className="ml-auto flex items-center gap-2">
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => setShowMaskPanel(p => !p)}>Mask</button>
          <button className="rounded bg-white/10 px-2 py-1" onClick={() => setShowConfigPanel(p => !p)}>Config</button>
          <button className="rounded bg-[#ff9d42] px-3 py-1.5 font-semibold text-black" onClick={() => setFinishModalOpen(true)}>Export</button>
        </div>
      </div>

      {/* ---- MAIN LAYOUT: sidebar + canvas + right panel ---- */}
      <div className="flex flex-1 overflow-hidden bg-[#0d1117]">
        {/* LEFT SIDEBAR: page thumbnails */}
        <div className="w-28 flex-shrink-0 overflow-y-auto border-r border-white/10 bg-[#0b0f18] p-2 space-y-2">
          {pages.map((page, idx) => (
            <button key={page.id} className={`group relative w-full overflow-hidden rounded-lg border-2 ${idx === activePageIndex ? "border-[#ff9d42]" : "border-transparent hover:border-white/30"}`} onClick={() => setActivePageIndex(idx)}>
              <img src={page.original_preview} alt={page.file_name} className="aspect-[3/4] w-full object-cover" />
              <span className="absolute bottom-0 inset-x-0 bg-black/70 text-[9px] text-center text-white/80 py-0.5">{idx + 1}</span>
              {page.pipeline_status === "running" && <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-[#ff9d42] animate-pulse" />}
              {page.pipeline_status === "done" && <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-green-400" />}
              {page.pipeline_status === "error" && <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-red-400" />}
            </button>
          ))}
          <button className="w-full rounded-lg border-2 border-dashed border-white/20 py-3 text-white/40 hover:text-white/70 text-lg" onClick={() => inputRef.current?.click()}>+</button>
          <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => void onPickFiles(e.target.files)} />
        </div>

        {/* CENTER: Canvas */}
        <div ref={stageRef} className="relative flex-1 overflow-hidden">
          {/* Interaction overlay for pan/zoom */}
          <div className={`absolute inset-0 z-20 ${effectiveToolMode === "zoom" ? "cursor-zoom-in" : effectiveToolMode === "pan" ? (panDrag ? "cursor-grabbing" : "cursor-grab") : "cursor-default"}`} style={{ pointerEvents: effectiveToolMode === "select" ? "none" : "auto" }}
            onMouseDown={e => {
              if (e.button !== 0) return;
              if (effectiveToolMode === "zoom") { zoomAtPoint(e.clientX, e.clientY, e.shiftKey ? -10 : 10); return; }
              if (effectiveToolMode === "pan") { e.preventDefault(); setPanDrag({ startClientX: e.clientX, startClientY: e.clientY, startX: panOffset.x, startY: panOffset.y }); }
            }} />

          {/* Image + regions */}
          <div className="absolute z-10 overflow-hidden rounded-lg" style={{ left: `${displayedRect.x + panOffset.x}px`, top: `${displayedRect.y + panOffset.y}px`, width: `${displayedRect.width}px`, height: `${displayedRect.height}px` }}>
            <img src={displayImageSrc} alt={currentPage.file_name} className="absolute inset-0 h-full w-full object-cover" />
            {showGrid && <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "5% 5%" }} />}

            {/* Mask regions */}
            {showMaskPreview && (
              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ pointerEvents: effectiveToolMode === "select" ? "auto" : "none" }}>
                {currentPage.mask_regions.map(r => {
                  const sel = r.id === currentPage.selected_mask_region_id;
                  const fill = r.label === "bubble" ? "rgba(249,115,22,0.28)" : "rgba(56,189,248,0.22)";
                  const stroke = sel ? (r.label === "bubble" ? "#f97316" : "#38bdf8") : "transparent";
                  const poly = normalizePolygon(r.polygon);
                  const onSel = (ev: React.MouseEvent<SVGElement>) => { if (effectiveToolMode !== "select") return; ev.preventDefault(); ev.stopPropagation(); updateCurrentPage(p => ({ ...p, selected_mask_region_id: r.id })); setRegionDrag({ kind: "mask", mode: "move", id: r.id, startClientX: ev.clientX, startClientY: ev.clientY, startX: r.x, startY: r.y, startWidth: r.width, startHeight: r.height, startPolygon: poly, displayWidth: displayedRect.width, displayHeight: displayedRect.height }); };
                  const delMask = (ev: React.MouseEvent) => { ev.preventDefault(); ev.stopPropagation(); updateCurrentPage(p => ({ ...p, mask_regions: p.mask_regions.filter(mr => mr.id !== r.id), detect_regions: p.detect_regions.filter(dr => dr.id !== r.id), selected_mask_region_id: null })); };
                  const vertexHandles = sel && poly && poly.length >= 3 ? poly.map((pt, vi) => (
                    <circle key={`v-${vi}`} cx={pt.x} cy={pt.y} r={0.6} fill="#ff9d42" stroke="#000" strokeWidth={0.15} style={{ cursor: "crosshair" }} onMouseDown={ev => { ev.preventDefault(); ev.stopPropagation(); setVertexDrag({ regionId: r.id, vertexIndex: vi, startClientX: ev.clientX, startClientY: ev.clientY, startPtX: pt.x, startPtY: pt.y, displayWidth: displayedRect.width, displayHeight: displayedRect.height }); }} />
                  )) : null;
                  if (poly && poly.length >= 3) return <g key={r.id}><polygon points={poly.map(pt => `${pt.x},${pt.y}`).join(" ")} fill={fill} stroke={stroke} strokeWidth={sel ? 0.25 : 0} onMouseDown={onSel} />{vertexHandles}{sel && <text x={r.x + r.width - 1.2} y={r.y + 1.8} fontSize={2} fill="#ef4444" style={{ cursor: "pointer" }} onMouseDown={delMask}>✕</text>}</g>;
                  return <g key={r.id}><rect x={r.x} y={r.y} width={r.width} height={r.height} fill={fill} stroke={stroke} strokeWidth={sel ? 0.25 : 0} onMouseDown={onSel} />{sel && <text x={r.x + r.width - 1.2} y={r.y + 1.8} fontSize={2} fill="#ef4444" style={{ cursor: "pointer" }} onMouseDown={delMask}>✕</text>}</g>;
                })}
              </svg>
            )}

            {/* Text regions */}
            {showRegions && filteredRegions.map(r => {
              const sel = r.id === currentPage.selected_region_id;
              const bph = (r.height / 100) * displayedRect.height;
              const fs = Math.max(8, Math.min(r.font_size * displayedRect.scale, Math.max(10, bph / 2.6)));
              const op = Math.max(1, Math.round(r.outline_width));
              const ts = r.outline_enabled ? [`-${op}px 0 ${r.outline_color}`, `${op}px 0 ${r.outline_color}`, `0 -${op}px ${r.outline_color}`, `0 ${op}px ${r.outline_color}`].join(", ") : "none";
              return (
                <div key={r.id} className="absolute rounded-md text-left" style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.width}%`, height: `${r.height}%`, zIndex: sel ? 12 : 11, backgroundColor: r.background_opacity > 0 ? hexToRgba(r.background_color, r.background_opacity) : "transparent", backdropFilter: r.background_blur ? `blur(${r.background_blur}px)` : undefined, boxShadow: sel ? "0 0 0 1px rgba(255,157,66,.95)" : "none" }}
                  onMouseDown={e => { if (effectiveToolMode !== "select") return; e.preventDefault(); e.stopPropagation(); updateCurrentPage(p => ({ ...p, selected_region_id: r.id })); setRegionDrag({ kind: "text", mode: "move", id: r.id, startClientX: e.clientX, startClientY: e.clientY, startX: r.x, startY: r.y, startWidth: r.width, startHeight: r.height, startPolygon: null, displayWidth: displayedRect.width, displayHeight: displayedRect.height }); }}>
                  {showText && <span style={{ display: "block", padding: "4px 6px", fontFamily: r.font_family, fontSize: `${fs}px`, fontStyle: r.font_style, fontWeight: r.font_weight, color: hexToRgba(r.text_color, r.text_opacity), whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.15, textShadow: ts }}>{r.translated_text || r.source_text || "(empty)"}</span>}
                  {sel && effectiveToolMode === "select" && <button className="absolute h-3 w-3 rounded-sm border border-[#ff9d42] bg-black/70" style={{ right: -6, bottom: -6, cursor: "nwse-resize" }} onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setRegionDrag({ kind: "text", mode: "resize", id: r.id, startClientX: e.clientX, startClientY: e.clientY, startX: r.x, startY: r.y, startWidth: r.width, startHeight: r.height, startPolygon: null, displayWidth: displayedRect.width, displayHeight: displayedRect.height }); }} />}
                </div>
              );
            })}
          </div>

          {/* Floating mask panel */}
          {showMaskPanel && (
            <div className="tool-window absolute left-3 bottom-3 z-30 w-72 rounded-xl p-3 text-xs space-y-2" onWheelCapture={e => e.stopPropagation()}>
              <div className="flex items-center justify-between"><span className="font-semibold">Mask Controls</span><button className="text-white/60" onClick={() => setShowMaskPanel(false)}>x</button></div>
              <label className="block">Bubble +px <input type="range" className="w-full" min={0} max={40} value={maskControls.inpaintBubbleExpandPx} onChange={e => setMaskControls(p => ({ ...p, inpaintBubbleExpandPx: +e.target.value }))} /></label>
              <label className="block">Text +px <input type="range" className="w-full" min={0} max={30} value={maskControls.inpaintTextExpandPx} onChange={e => setMaskControls(p => ({ ...p, inpaintTextExpandPx: +e.target.value }))} /></label>
              <label className="block">Bubble scale <input type="range" className="w-full" min={0.6} max={2} step={0.01} value={maskControls.inpaintBubbleScale} onChange={e => setMaskControls(p => ({ ...p, inpaintBubbleScale: +e.target.value }))} /></label>
              <label className="block">Text scale <input type="range" className="w-full" min={0.6} max={2} step={0.01} value={maskControls.inpaintTextScale} onChange={e => setMaskControls(p => ({ ...p, inpaintTextScale: +e.target.value }))} /></label>
              <div className="grid grid-cols-2 gap-2">
                <button className="rounded bg-white/15 px-2 py-1.5" onClick={() => void previewMaskForCurrent()} disabled={maskPreviewLoading}>{maskPreviewLoading ? "Building..." : "Preview Mask"}</button>
                <button className="rounded bg-white/15 px-2 py-1.5" onClick={() => setShowMaskPreview(p => !p)} disabled={!currentPage.mask_regions.length}>{showMaskPreview ? "Hide" : "Show"}</button>
              </div>
              <button className="w-full rounded bg-[#ff9d42] px-2 py-1.5 font-semibold text-black disabled:opacity-50" onClick={() => void applyInpaint()} disabled={inpaintLoading || !currentPage.mask_regions.length}>{inpaintLoading ? "Inpainting..." : "Apply Inpaint"}</button>
              {maskPreviewError && <p className="text-amber-200">{maskPreviewError}</p>}
            </div>
          )}

          {/* Floating config panel */}
          {showConfigPanel && (
            <div className="tool-window absolute right-3 bottom-3 z-30 w-64 rounded-xl p-3 text-xs space-y-2" onWheelCapture={e => e.stopPropagation()}>
              <div className="flex items-center justify-between"><span className="font-semibold">Pipeline Config</span><button className="text-white/60" onClick={() => setShowConfigPanel(false)}>x</button></div>
              {(["detector", "inpainter", "ocr", "translator"] as const).map(stage => (
                <label key={stage} className="block">{stage}
                  <select className="mt-1 w-full rounded bg-[#141b2a] p-1.5" value={pipelineConfig[stage]?.provider || "custom"} onChange={e => { setPipelineConfig(p => ({ ...p, [stage]: { ...(p[stage] || {}), provider: e.target.value } })); if (stage === "translator") setTranslatorEngine(e.target.value); }}>
                    {(providerCatalog.length ? providerCatalog : [{ name: "custom", enabled: true }, { name: "stub", enabled: true }]).map(p => <option key={p.name} value={p.name} disabled={!p.enabled}>{p.name}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <div className="w-[340px] flex-shrink-0 overflow-y-auto border-l border-white/10 bg-[#0b0f18] p-4 text-xs space-y-4" onWheelCapture={e => e.stopPropagation()}>
          {/* Language */}
          <div className="grid grid-cols-2 gap-2">
            <label>Source<select className="mt-1 w-full rounded bg-[#141b2a] p-1.5" value={sourceLang} onChange={e => setSourceLang(e.target.value)}><option value="ja">Japanese</option><option value="en">English</option><option value="ru">Russian</option></select></label>
            <label>Target<select className="mt-1 w-full rounded bg-[#141b2a] p-1.5" value={targetLang} onChange={e => setTargetLang(e.target.value)}><option value="ru">Russian</option><option value="en">English</option><option value="es">Spanish</option><option value="de">German</option><option value="fr">French</option><option value="ko">Korean</option><option value="zh">Chinese</option><option value="uk">Ukrainian</option></select></label>
          </div>

          {/* Text editing */}
          <div className="space-y-1.5">
            <textarea className="w-full rounded bg-[#141b2a] p-2" rows={3} value={draftSourceText} onChange={e => setDraftSourceText(e.target.value)} placeholder="Source text" />
            <textarea className="w-full rounded bg-[#141b2a] p-2" rows={3} value={draftTranslatedText} onChange={e => setDraftTranslatedText(e.target.value)} placeholder="Translated text" />
            <div className="grid grid-cols-2 gap-1.5">
              <button className="rounded bg-white/15 px-2 py-1.5" onClick={insertDraftToSelected}>Insert</button>
              <button className="rounded bg-white/15 px-2 py-1.5 disabled:opacity-50" onClick={() => void translateCurrentDraft()} disabled={translationLoading}>{translationLoading ? "..." : "Translate"}</button>
            </div>
          </div>

          {/* QA + Progress */}
          <div className="rounded bg-[#121827] p-2">QA: {quality.approved}/{quality.total} ({quality.progress}%){projectProgress ? <span className="ml-2">| Project: {projectProgress.done}/{projectProgress.total_pages}</span> : null}</div>

          {/* Font styling */}
          {selectedRegion && (
            <div className="space-y-1.5 rounded bg-[#121827] p-2">
              <p className="text-[10px] uppercase tracking-widest text-white/50">Style</p>
              <select className="w-full rounded bg-[#141b2a] p-1.5" value={selectedRegion.font_family} onChange={e => updateRegion(selectedRegion.id, { font_family: e.target.value })}><option>Arial</option><option>Times New Roman</option><option>Verdana</option><option>Impact</option></select>
              <div className="grid grid-cols-3 gap-1">
                <select className="rounded bg-[#141b2a] p-1" value={selectedRegion.font_style} onChange={e => updateRegion(selectedRegion.id, { font_style: e.target.value as "normal" | "italic" })}><option value="normal">Normal</option><option value="italic">Italic</option></select>
                <select className="rounded bg-[#141b2a] p-1" value={selectedRegion.font_weight} onChange={e => updateRegion(selectedRegion.id, { font_weight: e.target.value as "400" | "600" | "700" })}><option value="400">400</option><option value="600">600</option><option value="700">700</option></select>
                <select className="rounded bg-[#141b2a] p-1" value={selectedRegion.font_size} onChange={e => updateRegion(selectedRegion.id, { font_size: +e.target.value })}>{[16, 20, 24, 28, 32, 36, 40, 48].map(s => <option key={s} value={s}>{s}</option>)}</select>
              </div>
              <div className="grid grid-cols-[36px_1fr] items-center gap-1"><input type="color" value={selectedRegion.text_color} onChange={e => updateRegion(selectedRegion.id, { text_color: e.target.value })} className="h-6 w-6" /><span>Text {selectedRegion.text_color}</span></div>
              <label className="flex items-center justify-between"><span>Outline</span><input type="checkbox" checked={selectedRegion.outline_enabled} onChange={e => updateRegion(selectedRegion.id, { outline_enabled: e.target.checked })} /></label>
              {selectedRegion.outline_enabled && <>
                <div className="grid grid-cols-[36px_1fr] items-center gap-1"><input type="color" value={selectedRegion.outline_color} onChange={e => updateRegion(selectedRegion.id, { outline_color: e.target.value })} className="h-6 w-6" /><span>{selectedRegion.outline_color}</span></div>
                <label>Width <input type="range" className="w-full" min={0} max={8} value={selectedRegion.outline_width} onChange={e => updateRegion(selectedRegion.id, { outline_width: +e.target.value })} /></label>
              </>}
              <label>BG Opacity <input type="range" className="w-full" min={0} max={1} step={0.01} value={selectedRegion.background_opacity} onChange={e => updateRegion(selectedRegion.id, { background_opacity: +e.target.value })} /></label>
              <label>BG Blur <input type="range" className="w-full" min={0} max={10} step={0.2} value={selectedRegion.background_blur} onChange={e => updateRegion(selectedRegion.id, { background_blur: +e.target.value })} /></label>
              <textarea className="w-full rounded bg-[#141b2a] p-1.5" rows={2} value={selectedRegion.translated_text} onChange={e => updateRegion(selectedRegion.id, { translated_text: e.target.value, review_status: e.target.value.trim() ? "edited" : selectedRegion.review_status })} />
              <button className="w-full rounded bg-red-500/25 px-2 py-1" onClick={() => { updateCurrentPage(p => { const nr = p.regions.filter(r => r.id !== selectedRegion.id); return { ...p, regions: nr, selected_region_id: nr[0]?.id ?? null }; }); }}>Delete region</button>
            </div>
          )}

          {/* Selected mask region info */}
          {!selectedRegion && selectedMaskRegion && (
            <div className="space-y-1.5 rounded bg-[#121827] p-2">
              <p className="text-[10px] uppercase tracking-widest text-white/50">Mask Region</p>
              <p>ID: {selectedMaskRegion.id}</p>
              <p>Label: <span className={selectedMaskRegion.label === "bubble" ? "text-orange-400" : "text-sky-400"}>{selectedMaskRegion.label}</span></p>
              <p>Confidence: {(selectedMaskRegion.confidence * 100).toFixed(1)}%</p>
              <p>Vertices: {selectedMaskRegion.polygon?.length ?? 0}</p>
              <button className="w-full rounded bg-red-500/25 px-2 py-1" onClick={() => updateCurrentPage(p => ({ ...p, mask_regions: p.mask_regions.filter(r => r.id !== selectedMaskRegion.id), detect_regions: p.detect_regions.filter(r => r.id !== selectedMaskRegion.id), selected_mask_region_id: null }))}>Delete mask region</button>
            </div>
          )}

          {/* Region list */}
          <div className="space-y-1">
            <div className="flex gap-1">
              <input className="flex-1 rounded bg-[#141b2a] p-1.5" value={searchText} onChange={e => setSearchText(e.target.value)} placeholder="Search..." />
              <select className="rounded bg-[#141b2a] p-1.5" value={filterMode} onChange={e => setFilterMode(e.target.value as FilterMode)}>
                <option value="all">all</option><option value="todo">todo</option><option value="edited">edited</option><option value="approved">approved</option><option value="low_confidence">low conf</option><option value="empty">empty</option>
              </select>
            </div>
            <div className="max-h-[40vh] space-y-1 overflow-auto">
              {filteredRegions.map(r => (
                <button key={r.id} className={`w-full rounded p-1.5 text-left ${r.id === currentPage.selected_region_id ? "bg-[#ff9d42]/20" : "bg-[#141b2a]"}`} onClick={() => updateCurrentPage(p => ({ ...p, selected_region_id: r.id }))}>
                  <div className="flex items-center justify-between"><span>{r.id}</span><span style={{ color: statusColor(r.review_status) }}>{r.review_status}</span></div>
                  <p className="truncate text-[10px] text-white/60">{r.translated_text || r.source_text || "(empty)"}</p>
                </button>
              ))}
            </div>
          </div>

          {currentPage.pipeline_error && <p className="text-red-300 text-[11px]">{currentPage.pipeline_error}</p>}
        </div>
      </div>

      {/* ---- EXPORT MODAL ---- */}
      {finishModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="tool-window w-full max-w-2xl rounded-2xl p-5">
            <h3 className="text-2xl font-semibold">Export</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="rounded bg-[#141b2a] p-3 text-sm">Scope<select className="mt-2 w-full rounded bg-black/25 p-2" value={exportOptions.scope} onChange={e => setExportOptions(p => ({ ...p, scope: e.target.value as "current" | "all" }))}><option value="current">Current page</option><option value="all">All pages</option></select></label>
              <label className="rounded bg-[#141b2a] p-3 text-sm">Prefix<input className="mt-2 w-full rounded bg-black/25 p-2" value={exportOptions.prefix} onChange={e => setExportOptions(p => ({ ...p, prefix: e.target.value }))} /></label>
            </div>
            <div className="mt-4 grid gap-2 rounded bg-[#141b2a] p-3 text-sm">
              <label className="flex items-center justify-between"><span>JSON</span><input type="checkbox" checked={exportOptions.export_json} onChange={e => setExportOptions(p => ({ ...p, export_json: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>PNG</span><input type="checkbox" checked={exportOptions.export_png} onChange={e => setExportOptions(p => ({ ...p, export_png: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>Project</span><input type="checkbox" checked={exportOptions.export_project} onChange={e => setExportOptions(p => ({ ...p, export_project: e.target.checked }))} /></label>
              <label className="flex items-center justify-between"><span>Include styles</span><input type="checkbox" checked={exportOptions.include_styles} onChange={e => setExportOptions(p => ({ ...p, include_styles: e.target.checked }))} /></label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="rounded bg-white/15 px-4 py-2" onClick={() => void onExportServerZip()}>ZIP (server)</button>
              <button className="rounded bg-white/15 px-4 py-2" onClick={() => setFinishModalOpen(false)}>Cancel</button>
              <button className="rounded bg-[#ff9d42] px-4 py-2 font-semibold text-black" onClick={() => void onConfirmFinish()}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {notice && <div className="fixed bottom-4 right-4 z-50 rounded-lg bg-black/80 px-4 py-2 text-sm text-white cursor-pointer" onClick={() => setNotice(null)}>{notice}</div>}
    </section>
  );
}
