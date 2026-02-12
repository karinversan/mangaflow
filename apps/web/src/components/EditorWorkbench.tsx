"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPipelineRuns, PipelineRunItem, runPipeline } from "@/lib/api";
import { DetectedRegion } from "@/lib/types";

type Status = "idle" | "running" | "done" | "error";
type ReviewStatus = "todo" | "edited" | "approved";
type FilterMode = "all" | "todo" | "edited" | "approved" | "low_confidence" | "empty";
type PanelKey = "workflow" | "inspector";

type EditorRegion = DetectedRegion & {
  review_status: ReviewStatus;
  note: string;
  font_size: number;
};

type DragState = {
  id: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

type PanelDragState = {
  key: PanelKey;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
};

type ImageMeta = {
  width: number;
  height: number;
};

type SavedSession = {
  project_name: string;
  target_lang: string;
  preview: string | null;
  image_meta: ImageMeta | null;
  regions: EditorRegion[];
  saved_at: string;
};

type PanelState = {
  hidden: boolean;
  collapsed: boolean;
  docked: boolean;
  x: number;
  y: number;
  width: number;
};

const STORAGE_KEY = "mangaflow_editor_session_v1";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toEditorRegion(region: DetectedRegion): EditorRegion {
  return {
    ...region,
    review_status: region.translated_text?.trim() ? "edited" : "todo",
    note: "",
    font_size: 16
  };
}

function cloneRegions(regions: EditorRegion[]): EditorRegion[] {
  return regions.map((region) => ({ ...region }));
}

function statusColor(status: ReviewStatus): string {
  if (status === "approved") return "#22c55e";
  if (status === "edited") return "#38bdf8";
  return "#ff9d42";
}

export function EditorWorkbench() {
  const [projectName, setProjectName] = useState("Новый проект");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [targetLang, setTargetLang] = useState("ru");
  const [regions, setRegions] = useState<EditorRegion[]>([]);
  const [runs, setRuns] = useState<PipelineRunItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRegions, setShowRegions] = useState(true);
  const [showTranslatedText, setShowTranslatedText] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchText, setSearchText] = useState("");
  const [zoom, setZoom] = useState(100);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [panelDragState, setPanelDragState] = useState<PanelDragState | null>(null);
  const [panels, setPanels] = useState<Record<PanelKey, PanelState>>({
    workflow: { hidden: false, collapsed: false, docked: true, x: 24, y: 24, width: 350 },
    inspector: { hidden: false, collapsed: false, docked: true, x: 980, y: 24, width: 390 }
  });

  const stageRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const regionsRef = useRef<EditorRegion[]>([]);
  const historyRef = useRef<EditorRegion[][]>([]);
  const historyIndexRef = useRef(-1);

  const canRun = useMemo(() => Boolean(file) && status !== "running", [file, status]);

  const quality = useMemo(() => {
    const total = regions.length;
    const approved = regions.filter((r) => r.review_status === "approved").length;
    const empty = regions.filter((r) => !r.translated_text.trim()).length;
    const lowConfidence = regions.filter((r) => r.confidence < 0.9).length;
    const progress = total ? Math.round((approved / total) * 100) : 0;
    return { total, approved, empty, lowConfidence, progress };
  }, [regions]);

  const filteredRegions = useMemo(() => {
    const query = searchText.trim().toLowerCase();

    return regions.filter((region) => {
      if (filterMode === "todo" && region.review_status !== "todo") return false;
      if (filterMode === "edited" && region.review_status !== "edited") return false;
      if (filterMode === "approved" && region.review_status !== "approved") return false;
      if (filterMode === "low_confidence" && region.confidence >= 0.9) return false;
      if (filterMode === "empty" && region.translated_text.trim()) return false;

      if (!query) return true;

      const haystack = `${region.id} ${region.source_text} ${region.translated_text} ${region.note}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [filterMode, regions, searchText]);

  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === selectedRegionId) ?? null,
    [regions, selectedRegionId]
  );

  const workspaceWidth = imageMeta ? Math.round(imageMeta.width * (zoom / 100)) : 980;
  const workspaceHeight = imageMeta ? Math.round(imageMeta.height * (zoom / 100)) : 1400;

  const resetHistory = (nextRegions: EditorRegion[]) => {
    historyRef.current = [cloneRegions(nextRegions)];
    historyIndexRef.current = 0;
  };

  const commitHistory = (nextRegions: EditorRegion[]) => {
    const next = cloneRegions(nextRegions);
    const currentStack = historyRef.current;
    const index = historyIndexRef.current;
    const current = currentStack[index];

    if (current && JSON.stringify(current) === JSON.stringify(next)) return;

    const sliced = currentStack.slice(0, index + 1);
    sliced.push(next);
    historyRef.current = sliced;
    historyIndexRef.current = sliced.length - 1;
  };

  const applyRegions = (
    updater: EditorRegion[] | ((current: EditorRegion[]) => EditorRegion[]),
    trackHistory = true
  ) => {
    setRegions((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      if (trackHistory) commitHistory(next);
      return next;
    });
  };

  const updatePanel = (key: PanelKey, patch: Partial<PanelState>) => {
    setPanels((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const undo = () => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current -= 1;
    setRegions(cloneRegions(historyRef.current[historyIndexRef.current]));
  };

  const redo = () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    setRegions(cloneRegions(historyRef.current[historyIndexRef.current]));
  };

  const loadRuns = async () => {
    try {
      const history = await fetchPipelineRuns();
      setRuns(history);
    } catch {
      // non-critical
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  useEffect(() => {
    regionsRef.current = regions;
  }, [regions]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (dragState && workspaceRef.current) {
        const dx = event.clientX - dragState.startClientX;
        const dy = event.clientY - dragState.startClientY;

        const dxPercent = (dx / workspaceRef.current.clientWidth) * 100;
        const dyPercent = (dy / workspaceRef.current.clientHeight) * 100;

        applyRegions(
          (current) =>
            current.map((region) => {
              if (region.id !== dragState.id) return region;

              const nextX = clamp(dragState.startX + dxPercent, 0, 100 - region.width);
              const nextY = clamp(dragState.startY + dyPercent, 0, 100 - region.height);

              return { ...region, x: Number(nextX.toFixed(2)), y: Number(nextY.toFixed(2)) };
            }),
          false
        );
      }

      if (panelDragState && stageRef.current) {
        const dx = event.clientX - panelDragState.startClientX;
        const dy = event.clientY - panelDragState.startClientY;

        setPanels((current) => {
          const panel = current[panelDragState.key];
          const stage = stageRef.current;
          if (!stage) return current;

          const maxX = Math.max(12, stage.clientWidth - panel.width - 12);
          const maxY = Math.max(12, stage.clientHeight - 60);

          const nextX = clamp(panelDragState.startX + dx, 12, maxX);
          const nextY = clamp(panelDragState.startY + dy, 12, maxY);

          return {
            ...current,
            [panelDragState.key]: {
              ...panel,
              x: nextX,
              y: nextY
            }
          };
        });
      }
    };

    const onMouseUp = () => {
      if (dragState) commitHistory(regionsRef.current);
      setDragState(null);
      setPanelDragState(null);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragState, panelDragState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingInInput =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveSession();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
        return;
      }

      if (typingInInput) return;

      if ((event.key === "Delete" || event.key === "Backspace") && selectedRegionId) {
        event.preventDefault();
        removeSelected();
        return;
      }

      if (!selectedRegionId) return;

      const step = event.shiftKey ? 2 : 0.5;

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        applyRegions((current) =>
          current.map((region) => {
            if (region.id !== selectedRegionId) return region;

            if (event.key === "ArrowLeft") {
              return { ...region, x: Number(clamp(region.x - step, 0, 100 - region.width).toFixed(2)) };
            }
            if (event.key === "ArrowRight") {
              return { ...region, x: Number(clamp(region.x + step, 0, 100 - region.width).toFixed(2)) };
            }
            if (event.key === "ArrowUp") {
              return { ...region, y: Number(clamp(region.y - step, 0, 100 - region.height).toFixed(2)) };
            }
            return { ...region, y: Number(clamp(region.y + step, 0, 100 - region.height).toFixed(2)) };
          })
        );
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRegionId]);

  const onFileChange = (inputFile: File | null) => {
    setFile(inputFile);
    setRegions([]);
    setSelectedRegionId(null);
    setError(null);

    if (!inputFile) {
      setPreview(null);
      setImageMeta(null);
      resetHistory([]);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      setPreview(result);

      if (result) {
        const img = new Image();
        img.onload = () => setImageMeta({ width: img.naturalWidth, height: img.naturalHeight });
        img.src = result;
      }
    };
    reader.readAsDataURL(inputFile);

    resetHistory([]);
  };

  const onRunPipeline = async () => {
    if (!file) return;

    setStatus("running");
    setError(null);

    try {
      const response = await runPipeline(file, targetLang);
      const mapped = response.regions.map(toEditorRegion);
      setRegions(mapped);
      setSelectedRegionId(mapped[0]?.id ?? null);
      setStatus("done");
      resetHistory(mapped);
      await loadRuns();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Unknown pipeline error");
    }
  };

  const updateRegion = (id: string, patch: Partial<EditorRegion>) => {
    applyRegions((current) =>
      current.map((item) => {
        if (item.id !== id) return item;

        const next = { ...item, ...patch };
        if (patch.translated_text !== undefined && next.review_status === "todo" && patch.translated_text.trim()) {
          next.review_status = "edited";
        }
        return next;
      })
    );
  };

  const addRegion = () => {
    const id = `manual-${Date.now()}`;
    const newRegion: EditorRegion = {
      id,
      x: 36,
      y: 38,
      width: 22,
      height: 13,
      source_text: "",
      translated_text: "",
      confidence: 1,
      review_status: "todo",
      note: "",
      font_size: 16
    };
    applyRegions((current) => [...current, newRegion]);
    setSelectedRegionId(id);
  };

  const duplicateSelected = () => {
    if (!selectedRegion) return;
    const id = `dup-${Date.now()}`;
    const duplicate: EditorRegion = {
      ...selectedRegion,
      id,
      x: clamp(selectedRegion.x + 2, 0, 100 - selectedRegion.width),
      y: clamp(selectedRegion.y + 2, 0, 100 - selectedRegion.height),
      review_status: "todo"
    };

    applyRegions((current) => [...current, duplicate]);
    setSelectedRegionId(id);
  };

  const removeSelected = () => {
    if (!selectedRegionId) return;
    applyRegions((current) => current.filter((region) => region.id !== selectedRegionId));
    setSelectedRegionId(null);
  };

  const jumpToNextTodo = () => {
    const todo = regions.find((region) => region.review_status !== "approved" || !region.translated_text.trim());
    if (todo) setSelectedRegionId(todo.id);
  };

  const fitZoom = () => setZoom(100);

  const onExportJson = () => {
    const payload = JSON.stringify(
      {
        project_name: projectName,
        target_lang: targetLang,
        regions
      },
      null,
      2
    );

    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, "_") || "manga"}-translation.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onExportProject = () => {
    const payload: SavedSession = {
      project_name: projectName,
      target_lang: targetLang,
      preview,
      image_meta: imageMeta,
      regions,
      saved_at: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, "_") || "manga"}-project.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onImportProjectClick = () => importRef.current?.click();

  const onImportProject = async (fileInput: File | null) => {
    if (!fileInput) return;

    const text = await fileInput.text();
    const parsed = JSON.parse(text) as Partial<SavedSession>;

    if (!Array.isArray(parsed.regions)) {
      throw new Error("Invalid project format");
    }

    const loadedRegions = parsed.regions.map((region) => ({
      ...region,
      review_status: region.review_status ?? "todo",
      note: region.note ?? "",
      font_size: region.font_size ?? 16
    })) as EditorRegion[];

    setProjectName(parsed.project_name || "Импортированный проект");
    setTargetLang(parsed.target_lang || "ru");
    setPreview(parsed.preview || null);
    setImageMeta(parsed.image_meta || null);
    setRegions(loadedRegions);
    setSelectedRegionId(loadedRegions[0]?.id ?? null);
    resetHistory(loadedRegions);
  };

  const saveSession = () => {
    const payload: SavedSession = {
      project_name: projectName,
      target_lang: targetLang,
      preview,
      image_meta: imageMeta,
      regions,
      saved_at: new Date().toISOString()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  };

  const restoreSession = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as SavedSession;
      setProjectName(parsed.project_name || "Восстановленный проект");
      setTargetLang(parsed.target_lang || "ru");
      setPreview(parsed.preview || null);
      setImageMeta(parsed.image_meta || null);
      setRegions(parsed.regions || []);
      setSelectedRegionId(parsed.regions?.[0]?.id ?? null);
      resetHistory(parsed.regions || []);
    } catch {
      setError("Не удалось восстановить сессию");
    }
  };

  const clearSession = () => {
    localStorage.removeItem(STORAGE_KEY);
  };

  const onExportPreview = async () => {
    if (!preview || !imageMeta) return;

    const image = new Image();
    image.src = preview;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = imageMeta.width;
    canvas.height = imageMeta.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(image, 0, 0);

    for (const region of regions) {
      const x = (region.x / 100) * canvas.width;
      const y = (region.y / 100) * canvas.height;
      const w = (region.width / 100) * canvas.width;
      const h = (region.height / 100) * canvas.height;

      ctx.fillStyle = "rgba(255,255,255,0.94)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.18)";
      ctx.strokeRect(x, y, w, h);

      ctx.fillStyle = "#111";
      ctx.font = `${Math.max(14, Math.round(h * 0.35))}px sans-serif`;
      ctx.textBaseline = "top";
      const text = region.translated_text || region.source_text || "";
      ctx.fillText(text.slice(0, 90), x + 6, y + 4, w - 10);
    }

    const out = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = out;
    a.download = `${projectName.replace(/\s+/g, "_") || "manga"}-preview.png`;
    a.click();
  };

  const panelStyle = (key: PanelKey): React.CSSProperties => {
    const panel = panels[key];
    if (panel.docked) {
      if (key === "workflow") {
        return {
          left: 14,
          top: 14,
          width: panel.width,
          maxHeight: "calc(100% - 28px)"
        };
      }
      return {
        right: 14,
        top: 14,
        width: panel.width,
        maxHeight: "calc(100% - 28px)"
      };
    }

    return {
      left: panel.x,
      top: panel.y,
      width: panel.width,
      maxHeight: "calc(100% - 24px)"
    };
  };

  return (
    <section className="mx-auto w-full max-w-[1580px] px-4 pb-8">
      <div ref={stageRef} className="relative h-[calc(100vh-250px)] min-h-[680px] overflow-hidden rounded-3xl bg-[#070a12]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(255,157,66,0.2),transparent_40%)]" />

        <div className="canvas-hud absolute left-1/2 top-4 z-20 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/90">
          <button className="rounded bg-white/15 px-2 py-1" onClick={() => setZoom((z) => clamp(z - 10, 40, 240))}>
            -
          </button>
          <span>{zoom}%</span>
          <button className="rounded bg-white/15 px-2 py-1" onClick={() => setZoom((z) => clamp(z + 10, 40, 240))}>
            +
          </button>
          <button className="rounded bg-white/15 px-2 py-1" onClick={fitZoom}>
            100%
          </button>
          <label className="ml-2 flex items-center gap-1">
            <span>Grid</span>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          </label>
          <label className="flex items-center gap-1">
            <span>Boxes</span>
            <input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} />
          </label>
          <label className="flex items-center gap-1">
            <span>Text</span>
            <input
              type="checkbox"
              checked={showTranslatedText}
              onChange={(e) => setShowTranslatedText(e.target.checked)}
            />
          </label>
          <button className="rounded bg-white/15 px-2 py-1" onClick={() => updatePanel("workflow", { hidden: false })}>
            Workflow
          </button>
          <button className="rounded bg-white/15 px-2 py-1" onClick={() => updatePanel("inspector", { hidden: false })}>
            Inspector
          </button>
        </div>

        <div className="absolute inset-0 overflow-auto px-4 pb-4 pt-16">
          {!preview ? (
            <div className="flex h-full min-h-[620px] items-center justify-center rounded-2xl bg-[#0c1019] text-white/60">
              Загрузите изображение и запустите pipeline
            </div>
          ) : (
            <div
              ref={workspaceRef}
              className="relative mx-auto overflow-hidden rounded-xl"
              style={{ width: `${workspaceWidth}px`, height: `${workspaceHeight}px` }}
            >
              <img src={preview} alt="page preview" className="absolute inset-0 h-full w-full object-cover" />

              {showGrid ? (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
                    backgroundSize: "5% 5%"
                  }}
                />
              ) : null}

              {showRegions &&
                filteredRegions.map((region) => {
                  const isSelected = selectedRegionId === region.id;
                  const borderColor = statusColor(region.review_status);

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
                        backgroundColor: isSelected ? `${borderColor}44` : `${borderColor}22`
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        setSelectedRegionId(region.id);
                        setDragState({
                          id: region.id,
                          startClientX: event.clientX,
                          startClientY: event.clientY,
                          startX: region.x,
                          startY: region.y
                        });
                      }}
                    >
                      {showTranslatedText ? (
                        <span className="line-clamp-3 block px-2 py-1 text-[11px] font-medium text-white">
                          {region.translated_text || region.source_text || "(empty)"}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        {(["workflow", "inspector"] as PanelKey[]).map((key) => {
          const panel = panels[key];
          if (panel.hidden) return null;

          return (
            <div key={key} className="tool-window absolute z-30 overflow-hidden rounded-2xl" style={panelStyle(key)}>
              <div
                className={`flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2 ${
                  panel.docked ? "cursor-default" : "cursor-move"
                }`}
                onMouseDown={(event) => {
                  if (panel.docked) return;
                  setPanelDragState({
                    key,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    startX: panel.x,
                    startY: panel.y
                  });
                }}
              >
                <p className="text-sm font-semibold">{key === "workflow" ? "Workflow" : "Inspector"}</p>
                <div className="flex items-center gap-1 text-xs">
                  <button
                    className="rounded bg-white/15 px-2 py-1"
                    onClick={() => updatePanel(key, { docked: !panel.docked })}
                  >
                    {panel.docked ? "Открепить" : "Прикрепить"}
                  </button>
                  <button
                    className="rounded bg-white/15 px-2 py-1"
                    onClick={() => updatePanel(key, { collapsed: !panel.collapsed })}
                  >
                    {panel.collapsed ? "Развернуть" : "Свернуть"}
                  </button>
                  <button className="rounded bg-white/15 px-2 py-1" onClick={() => updatePanel(key, { hidden: true })}>
                    Скрыть
                  </button>
                </div>
              </div>

              {!panel.collapsed ? (
                <div className="tool-window-content max-h-[calc(100vh-330px)] overflow-auto p-3">
                  {key === "workflow" ? (
                    <div className="space-y-3 text-sm">
                      <div className="rounded-xl bg-[#121827] p-3">
                        <p className="text-xs uppercase tracking-[0.12em] text-white/55">QA Progress</p>
                        <p className="mt-1 text-2xl font-semibold">{quality.progress}%</p>
                        <div className="mt-2 h-2 w-full rounded-full bg-white/15">
                          <div className="h-full rounded-full bg-[#ff9d42]" style={{ width: `${quality.progress}%` }} />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-white/70">
                          <span>Всего: {quality.total}</span>
                          <span>Approved: {quality.approved}</span>
                          <span>Пустые: {quality.empty}</span>
                          <span>Low conf: {quality.lowConfidence}</span>
                        </div>
                      </div>

                      <div>
                        <label className="text-xs uppercase tracking-[0.12em] text-white/60">Название проекта</label>
                        <input
                          className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                          value={projectName}
                          onChange={(e) => setProjectName(e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="text-xs uppercase tracking-[0.12em] text-white/60">Файл страницы</label>
                        <input
                          className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                        />
                      </div>

                      <div>
                        <label className="text-xs uppercase tracking-[0.12em] text-white/60">Язык перевода</label>
                        <select
                          className="mt-1 w-full rounded-lg bg-[#141b2a] p-2"
                          value={targetLang}
                          onChange={(e) => setTargetLang(e.target.value)}
                        >
                          <option value="ru">Русский</option>
                          <option value="en">English</option>
                          <option value="es">Español</option>
                        </select>
                      </div>

                      <button
                        className="w-full rounded-lg bg-warm px-3 py-2 font-semibold text-black disabled:opacity-40"
                        disabled={!canRun}
                        onClick={onRunPipeline}
                      >
                        {status === "running" ? "Обработка..." : "Запустить pipeline"}
                      </button>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={addRegion}>
                          + Блок
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={duplicateSelected}>
                          Дубликат
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={removeSelected}>
                          Удалить
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={jumpToNextTodo}>
                          След. QA
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={undo}>
                          Undo
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={redo}>
                          Redo
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={onExportJson}>
                          Export JSON
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={onExportPreview}>
                          Export PNG
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={saveSession}>
                          Save session
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={restoreSession}>
                          Restore
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={onExportProject}>
                          Export project
                        </button>
                        <button className="rounded-lg bg-white/15 px-2 py-2" onClick={onImportProjectClick}>
                          Import
                        </button>
                      </div>

                      <input
                        ref={importRef}
                        className="hidden"
                        type="file"
                        accept="application/json"
                        onChange={async (e) => {
                          try {
                            await onImportProject(e.target.files?.[0] ?? null);
                          } catch {
                            setError("Не удалось импортировать проект");
                          }
                        }}
                      />

                      <button className="w-full rounded-lg bg-white/10 px-2 py-2 text-xs" onClick={clearSession}>
                        Очистить сохраненную сессию
                      </button>

                      <div className="rounded-xl bg-[#121827] p-3 text-xs text-white/70">
                        <p className="font-semibold text-white/80">Горячие клавиши</p>
                        <p className="mt-2">Ctrl/Cmd+Z/Y - Undo/Redo</p>
                        <p>Ctrl/Cmd+S - Save session</p>
                        <p>Ctrl/Cmd+D - Duplicate selected</p>
                        <p>Delete/Backspace - Remove selected</p>
                        <p>Arrows / Shift+Arrows - Move selected</p>
                      </div>

                      {error ? <p className="text-xs text-red-300">{error}</p> : null}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm">
                      <label className="block text-xs uppercase tracking-[0.12em] text-white/60">Поиск</label>
                      <input
                        className="w-full rounded-lg bg-[#141b2a] p-2"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        placeholder="ID, OCR, перевод, note"
                      />

                      <select
                        className="w-full rounded-lg bg-[#141b2a] p-2 text-xs"
                        value={filterMode}
                        onChange={(e) => setFilterMode(e.target.value as FilterMode)}
                      >
                        <option value="all">Filter: all</option>
                        <option value="todo">Filter: todo</option>
                        <option value="edited">Filter: edited</option>
                        <option value="approved">Filter: approved</option>
                        <option value="low_confidence">Filter: low confidence</option>
                        <option value="empty">Filter: empty</option>
                      </select>

                      {!selectedRegion ? (
                        <p className="rounded-lg bg-[#131a28] p-3 text-xs text-white/70">Сегмент не выбран.</p>
                      ) : (
                        <div className="space-y-3 rounded-xl bg-[#121827] p-3">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold">{selectedRegion.id}</span>
                            <span>{(selectedRegion.confidence * 100).toFixed(1)}%</span>
                          </div>

                          <select
                            className="w-full rounded-lg bg-[#141b2a] p-2 text-xs"
                            value={selectedRegion.review_status}
                            onChange={(e) =>
                              updateRegion(selectedRegion.id, { review_status: e.target.value as ReviewStatus })
                            }
                          >
                            <option value="todo">todo</option>
                            <option value="edited">edited</option>
                            <option value="approved">approved</option>
                          </select>

                          <textarea
                            className="w-full rounded-lg bg-[#141b2a] p-2 text-xs"
                            rows={3}
                            value={selectedRegion.source_text}
                            onChange={(e) => updateRegion(selectedRegion.id, { source_text: e.target.value })}
                            placeholder="OCR text"
                          />
                          <textarea
                            className="w-full rounded-lg bg-[#141b2a] p-2 text-xs"
                            rows={4}
                            value={selectedRegion.translated_text}
                            onChange={(e) => updateRegion(selectedRegion.id, { translated_text: e.target.value })}
                            placeholder="Translated text"
                          />
                          <textarea
                            className="w-full rounded-lg bg-[#141b2a] p-2 text-xs"
                            rows={2}
                            value={selectedRegion.note}
                            onChange={(e) => updateRegion(selectedRegion.id, { note: e.target.value })}
                            placeholder="QA note"
                          />

                          <div className="grid grid-cols-2 gap-2 text-[11px]">
                            <label>
                              X {selectedRegion.x.toFixed(1)}%
                              <input
                                type="range"
                                className="w-full"
                                min={0}
                                max={100 - selectedRegion.width}
                                step={0.1}
                                value={selectedRegion.x}
                                onChange={(e) => updateRegion(selectedRegion.id, { x: Number(e.target.value) })}
                              />
                            </label>
                            <label>
                              Y {selectedRegion.y.toFixed(1)}%
                              <input
                                type="range"
                                className="w-full"
                                min={0}
                                max={100 - selectedRegion.height}
                                step={0.1}
                                value={selectedRegion.y}
                                onChange={(e) => updateRegion(selectedRegion.id, { y: Number(e.target.value) })}
                              />
                            </label>
                            <label>
                              W {selectedRegion.width.toFixed(1)}%
                              <input
                                type="range"
                                className="w-full"
                                min={4}
                                max={100 - selectedRegion.x}
                                step={0.1}
                                value={selectedRegion.width}
                                onChange={(e) => updateRegion(selectedRegion.id, { width: Number(e.target.value) })}
                              />
                            </label>
                            <label>
                              H {selectedRegion.height.toFixed(1)}%
                              <input
                                type="range"
                                className="w-full"
                                min={4}
                                max={100 - selectedRegion.y}
                                step={0.1}
                                value={selectedRegion.height}
                                onChange={(e) => updateRegion(selectedRegion.id, { height: Number(e.target.value) })}
                              />
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="border-t border-white/10 pt-3">
                        <p className="text-xs text-white/70">Сегменты ({filteredRegions.length})</p>
                        <div className="mt-2 max-h-64 space-y-2 overflow-auto pr-1">
                          {filteredRegions.map((region) => (
                            <button
                              key={region.id}
                              className={`w-full rounded-lg p-2 text-left text-xs ${
                                selectedRegionId === region.id ? "bg-[#ff9d42]/25 text-white" : "bg-[#141b2a] text-white/80"
                              }`}
                              onClick={() => setSelectedRegionId(region.id)}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <p className="font-semibold">{region.id}</p>
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] uppercase"
                                  style={{
                                    backgroundColor: `${statusColor(region.review_status)}33`,
                                    color: statusColor(region.review_status)
                                  }}
                                >
                                  {region.review_status}
                                </span>
                              </div>
                              <p className="mt-1 truncate">{region.translated_text || region.source_text || "(пусто)"}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
