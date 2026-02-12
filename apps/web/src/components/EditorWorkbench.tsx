"use client";

import { useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import {
  createPipelineJob,
  fetchPageRegions,
  fetchPipelineJob,
  issueDevToken,
  patchRegion,
  runPipeline
} from "@/lib/api";
import { DetectedRegion } from "@/lib/types";

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
  preview: string;
  image_meta: ImageMeta;
  regions: EditorRegion[];
  project_id: string | null;
  server_page_id: string | null;
  region_id_map: Record<string, string>;
  selected_region_id: string | null;
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
  id: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  displayWidth: number;
  displayHeight: number;
};

type PanDragState = {
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  scope: "all",
  export_json: true,
  export_png: true,
  export_project: true,
  include_styles: true,
  prefix: "mangaflow"
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

function translateStub(text: string, target: string): string {
  if (!text.trim()) return "";
  if (target === "ru") return `Перевод: ${text}`;
  if (target === "en") return `Translation: ${text}`;
  if (target === "es") return `Traduccion: ${text}`;
  return text;
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
    background_color: "#ffffff",
    background_opacity: 0.92,
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

    ctx.fillStyle = hexToRgba(region.background_color, region.background_opacity);
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = hexToRgba(region.text_color, region.text_opacity);
    ctx.font = `${region.font_style} ${region.font_weight} ${Math.max(12, Math.round(region.font_size))}px ${region.font_family}`;
    ctx.textBaseline = "top";

    if (region.outline_enabled) {
      ctx.strokeStyle = region.outline_color;
      ctx.lineWidth = Math.max(1, region.font_size * 0.07);
      ctx.strokeText(region.translated_text || region.source_text || "", x + 6, y + 6, w - 12);
    }

    ctx.fillText(region.translated_text || region.source_text || "", x + 6, y + 6, w - 12);
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
  const [translatorEngine, setTranslatorEngine] = useState("google_stub");
  const [draftSourceText, setDraftSourceText] = useState("");
  const [draftTranslatedText, setDraftTranslatedText] = useState("");
  const [smartFillEnabled, setSmartFillEnabled] = useState(true);

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

  const currentPage = pages[activePageIndex] ?? null;
  const effectiveToolMode: ToolMode = isSpacePanning ? "pan" : toolMode;

  useEffect(() => {
    const initToken = async () => {
      try {
        const storageKey = "mangaflow_dev_user_id";
        const existing = window.localStorage.getItem(storageKey);
        const userId = existing || `dev-user-${Math.random().toString(36).slice(2, 10)}`;
        if (!existing) window.localStorage.setItem(storageKey, userId);
        const token = await issueDevToken(userId);
        setAuthToken(token);
      } catch {
        setNotice("JWT dev-token недоступен. Работа в local-only режиме.");
      }
    };
    void initToken();
  }, []);

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
            return {
              ...page,
              regions: page.regions.map((region) => {
                if (region.id !== regionDrag.id) return region;
                const x = clamp(regionDrag.startX + dxPercent, 0, 100 - region.width);
                const y = clamp(regionDrag.startY + dyPercent, 0, 100 - region.height);
                return { ...region, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)) };
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
      if (regionDrag && currentPage) {
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
        preview,
        image_meta,
        regions: [],
        project_id: null,
        server_page_id: null,
        region_id_map: {},
        selected_region_id: null,
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
      if (authToken) {
        const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const created = await createPipelineJob(
          {
            file: currentPage.file,
            targetLang,
            provider: "stub",
            requestId,
            projectId: currentPage.project_id ?? undefined,
            projectName: currentPage.file_name.replace(/\.[a-z0-9]+$/i, "")
          },
          authToken
        );

        let finalStatus: "done" | "failed" | null = null;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          const status = await fetchPipelineJob(created.job_id, authToken);
          if (status.status === "done" || status.status === "failed") {
            finalStatus = status.status;
            if (status.status === "failed") {
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

            updateCurrentPage((page) => ({
              ...page,
              project_id: created.project_id,
              server_page_id: created.page_id,
              region_id_map: regionMap,
              regions: mapped,
              selected_region_id: mapped[0]?.id ?? null,
              pipeline_status: "done",
              pipeline_error: null
            }));
            setDraftSourceText(mapped[0]?.source_text ?? "");
            setDraftTranslatedText(mapped[0]?.translated_text ?? "");
            break;
          }
          await sleep(900);
        }
        if (!finalStatus) {
          throw new Error("Pipeline timeout");
        }
      } else {
        const response = await runPipeline(currentPage.file, targetLang);
        const mapped = response.regions.map(toEditorRegion);
        updateCurrentPage((page) => ({
          ...page,
          regions: mapped,
          selected_region_id: mapped[0]?.id ?? null,
          pipeline_status: "done",
          pipeline_error: null
        }));
        setDraftSourceText(mapped[0]?.source_text ?? "");
        setDraftTranslatedText(mapped[0]?.translated_text ?? "");
      }
    } catch (e) {
      updateCurrentPage((page) => ({
        ...page,
        pipeline_status: "error",
        pipeline_error: e instanceof Error ? e.message : "Pipeline error"
      }));
    }
  };

  const translateCurrentDraft = () => setDraftTranslatedText(translateStub(draftSourceText, targetLang));

  const insertDraftToSelected = () => {
    if (!selectedRegion) return;
    updateRegion(selectedRegion.id, {
      source_text: draftSourceText,
      translated_text: draftTranslatedText,
      review_status: draftTranslatedText.trim() ? "edited" : selectedRegion.review_status
    });
  };

  const translateAll = () => {
    if (!currentPage) return;

    updateCurrentPage((page) => ({
      ...page,
      regions: page.regions.map((region) => ({
        ...region,
        translated_text: region.translated_text.trim() ? region.translated_text : translateStub(region.source_text, targetLang),
        review_status:
          region.review_status === "approved"
            ? "approved"
            : region.source_text.trim()
              ? "edited"
              : region.review_status
      }))
    }));
  };

  const addRegion = () => {
    if (!currentPage) return;

    const id = `manual-${Date.now()}`;
    const region: EditorRegion = {
      id,
      x: 36,
      y: 38,
      width: 22,
      height: 13,
      source_text: draftSourceText,
      translated_text: draftTranslatedText,
      confidence: 1,
      review_status: draftTranslatedText.trim() ? "edited" : "todo",
      note: "",
      font_family: "Arial",
      font_size: 24,
      font_style: "normal",
      font_weight: "600",
      text_color: "#000000",
      text_opacity: 1,
      outline_enabled: true,
      outline_color: "#ffffff",
      background_color: "#ffffff",
      background_opacity: 0.92,
      background_blur: 0
    };

    updateCurrentPage((page) => ({ ...page, regions: [...page.regions, region], selected_region_id: id }));
  };

  const removeSelected = () => {
    if (!currentPage || !currentPage.selected_region_id) return;
    const selectedId = currentPage.selected_region_id;
    updateCurrentPage((page) => ({
      ...page,
      regions: page.regions.filter((region) => region.id !== selectedId),
      selected_region_id: null
    }));
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

  const onStageWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();

    const shouldZoom = effectiveToolMode === "zoom" || event.ctrlKey || event.metaKey;
    if (shouldZoom) {
      const delta = event.deltaY < 0 ? 10 : -10;
      zoomAtPoint(event.clientX, event.clientY, delta);
      return;
    }

    const horizontalPreferred = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    panByWheel(event.deltaX, event.deltaY, horizontalPreferred);
  };

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
          <input ref={inputRef} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void onPickFiles(e.target.files)} />
        </div>

        <div className="flex items-center gap-2">
          <div className="mr-2 flex items-center gap-1 rounded bg-white/10 p-1">
            <button
              className={`rounded px-2 py-1 text-xs ${toolMode === "select" ? "bg-[#ff9d42] text-black" : "bg-white/10 text-white"}`}
              onClick={() => setToolMode("select")}
              title="Мышка (V): выбрать и двигать текстовые блоки"
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
          <label className="flex items-center gap-1"><span>Блоки</span><input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} /></label>
          <label className="flex items-center gap-1"><span>Текст</span><input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /></label>
          <button className="rounded bg-[#ff9d42] px-3 py-1 font-semibold text-black" onClick={() => setFinishModalOpen(true)}>Завершить редактирование</button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative h-[calc(100vh-300px)] min-h-[420px] overflow-hidden rounded-2xl bg-[#0b1019]"
        onWheel={onStageWheel}
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
            <img src={currentPage.preview} alt={currentPage.file_name} className="absolute inset-0 h-full w-full object-cover" />

            {showGrid ? (
              <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)", backgroundSize: "5% 5%" }} />
            ) : null}

            {showRegions && filteredRegions.map((region) => {
              const borderColor = statusColor(region.review_status);
              const isSelected = region.id === currentPage.selected_region_id;
              const textShadow = region.outline_enabled
                ? `-1px -1px 0 ${region.outline_color}, 1px -1px 0 ${region.outline_color}, -1px 1px 0 ${region.outline_color}, 1px 1px 0 ${region.outline_color}`
                : "none";

              return (
                <button
                  key={region.id}
                  className="absolute overflow-hidden rounded-md text-left"
                  style={{
                    left: `${region.x}%`,
                    top: `${region.y}%`,
                    width: `${region.width}%`,
                    height: `${region.height}%`,
                    border: isSelected ? `2px solid ${borderColor}` : `1px solid ${borderColor}`,
                    backgroundColor: hexToRgba(region.background_color, region.background_opacity),
                    backdropFilter: region.background_blur ? `blur(${region.background_blur}px)` : undefined
                  }}
                  onMouseDown={(event) => {
                    if (effectiveToolMode !== "select") return;
                    event.preventDefault();
                    event.stopPropagation();
                    updateCurrentPage((page) => ({ ...page, selected_region_id: region.id }));
                    setRegionDrag({
                      id: region.id,
                      startClientX: event.clientX,
                      startClientY: event.clientY,
                      startX: region.x,
                      startY: region.y,
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
                        fontSize: `${Math.max(8, region.font_size * displayedRect.scale)}px`,
                        fontStyle: region.font_style,
                        fontWeight: region.font_weight,
                        color: hexToRgba(region.text_color, region.text_opacity),
                        textShadow
                      }}
                    >
                      {region.translated_text || region.source_text || "(пусто)"}
                    </span>
                  ) : null}
                </button>
              );
            })}
        </div>

        {renderFloatingPanel(
          "workflow",
          "Перевод",
          <div className="space-y-2 text-xs">
            <div className="rounded-lg bg-[#121827] p-2">QA: {quality.approved}/{quality.total} ({quality.progress}%)</div>
            <div className="grid grid-cols-2 gap-2">
              <select className="rounded-lg bg-[#141b2a] p-2" value={translatorEngine} onChange={(e) => setTranslatorEngine(e.target.value)}>
                <option value="google_stub">Google переводчик</option>
                <option value="deepl_stub">DeepL</option>
                <option value="custom">Custom model</option>
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
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={translateCurrentDraft}>Перевести</button>
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={translateAll}>Перевести все</button>
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={runPipelineForCurrent} disabled={currentPage.pipeline_status === "running"}>{currentPage.pipeline_status === "running" ? "Обработка..." : "Pipeline"}</button>
            </div>
            <label className="flex items-center justify-between rounded-lg bg-[#121827] px-3 py-2"><span>Умная заливка</span><input type="checkbox" checked={smartFillEnabled} onChange={(e) => setSmartFillEnabled(e.target.checked)} /></label>
            <div className="grid grid-cols-2 gap-2">
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={addRegion}>+ Блок</button>
              <button className="rounded-lg bg-white/15 px-2 py-2" onClick={removeSelected}>Удалить</button>
            </div>
            {currentPage.pipeline_error ? <p className="text-red-300">{currentPage.pipeline_error}</p> : null}
          </div>,
          "left"
        )}

        {renderFloatingPanel(
          "text",
          "Текст",
          <div className="space-y-2 text-xs">
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
                <label className="flex items-center justify-between"><span>Обводка</span><input type="checkbox" checked={selectedRegion.outline_enabled} onChange={(e) => updateRegion(selectedRegion.id, { outline_enabled: e.target.checked })} /></label>
                <div className="grid grid-cols-[56px_1fr] items-center gap-2"><input type="color" value={selectedRegion.outline_color} onChange={(e) => updateRegion(selectedRegion.id, { outline_color: e.target.value })} /><span>{selectedRegion.outline_color}</span></div>
                <div className="grid grid-cols-[56px_1fr] items-center gap-2"><input type="color" value={selectedRegion.background_color} onChange={(e) => updateRegion(selectedRegion.id, { background_color: e.target.value })} /><span>{selectedRegion.background_color}</span></div>
                <label>Прозрачность фона<input type="range" className="w-full" min={0} max={1} step={0.01} value={selectedRegion.background_opacity} onChange={(e) => updateRegion(selectedRegion.id, { background_opacity: Number(e.target.value) })} /></label>
                <label>Блюр<input type="range" className="w-full" min={0} max={10} step={0.2} value={selectedRegion.background_blur} onChange={(e) => updateRegion(selectedRegion.id, { background_blur: Number(e.target.value) })} /></label>
                <textarea className="w-full rounded-lg bg-[#141b2a] p-2" rows={3} value={selectedRegion.translated_text} onChange={(e) => updateRegion(selectedRegion.id, { translated_text: e.target.value, review_status: e.target.value.trim() ? "edited" : selectedRegion.review_status })} />
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
