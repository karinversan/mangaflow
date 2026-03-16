"use client";
import { useState, useCallback } from "react";
import {
  createPipelineJob,
  fetchPipelineJob,
  fetchPageRegions,
  cancelPipelineJob,
  previewMask,
  previewInpaint,
  translateTexts,
  detectTextBoxes,
  runOcr,
  cleanImage,
} from "@/lib/api";
import { DetectRegion, DetectedRegion, MaskRegion, PipelineConfig } from "@/lib/types";
import { EditorRegion, MaskControls, PageDoc, EditorMode } from "./types";

const PIPELINE_POLL_MAX_ATTEMPTS = 600;
const PIPELINE_POLL_INTERVAL_MS = 1000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
    background_blur: 0,
  };
}

export type PipelineStage = "detect" | "ocr" | "translate" | "clean" | "render";

export function usePipeline() {
  const [editorMode, setEditorMode] = useState<EditorMode>("automatic");
  const [activeStage, setActiveStage] = useState<PipelineStage | null>(null);
  const [stageLoading, setStageLoading] = useState(false);

  // --- Manual stage: Detect ---
  const runDetect = useCallback(async (file: File, provider: string = "custom"): Promise<DetectRegion[]> => {
    setActiveStage("detect");
    setStageLoading(true);
    try {
      const resp = await detectTextBoxes(file, provider);
      return resp.regions;
    } finally {
      setStageLoading(false);
      setActiveStage(null);
    }
  }, []);

  // --- Manual stage: OCR ---
  const runOcrStage = useCallback(async (file: File, regions: DetectRegion[], provider: string = "custom"): Promise<string[]> => {
    setActiveStage("ocr");
    setStageLoading(true);
    try {
      const resp = await runOcr(file, regions, provider);
      return resp.texts;
    } finally {
      setStageLoading(false);
      setActiveStage(null);
    }
  }, []);

  // --- Manual stage: Translate ---
  const runTranslateStage = useCallback(async (texts: string[], targetLang: string, provider: string = "custom"): Promise<string[]> => {
    setActiveStage("translate");
    setStageLoading(true);
    try {
      const result = await translateTexts({ provider: provider as "stub" | "huggingface" | "custom", targetLang, texts });
      return result;
    } finally {
      setStageLoading(false);
      setActiveStage(null);
    }
  }, []);

  // --- Manual stage: Clean ---
  const runCleanStage = useCallback(async (file: File, regions: MaskRegion[], provider: string = "custom"): Promise<string> => {
    setActiveStage("clean");
    setStageLoading(true);
    try {
      const resp = await cleanImage(file, regions, provider);
      return `data:image/png;base64,${resp.inpainted_b64}`;
    } finally {
      setStageLoading(false);
      setActiveStage(null);
    }
  }, []);

  // --- Automatic (full pipeline) ---
  const runAutomatic = useCallback(async (params: {
    page: PageDoc;
    authToken: string;
    targetLang: string;
    pipelineConfig: PipelineConfig;
    maskControls: MaskControls;
    onUpdate: (updater: (page: PageDoc) => PageDoc) => void;
  }): Promise<{ regions: EditorRegion[]; maskRegions: MaskRegion[]; projectId: string; pageId: string; regionMap: Record<string, string> } | null> => {
    const { page, authToken, targetLang, pipelineConfig, maskControls, onUpdate } = params;
    onUpdate(p => ({ ...p, pipeline_status: "running", pipeline_error: null }));

    try {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created = await createPipelineJob({
        file: page.file,
        targetLang,
        provider: (pipelineConfig.detector?.provider as "stub" | "huggingface" | "custom") || "custom",
        requestId,
        projectId: page.project_id ?? undefined,
        projectName: page.file_name.replace(/\.[a-z0-9]+$/i, ""),
        pipelineConfig,
        inpaintBubbleExpandPx: maskControls.inpaintBubbleExpandPx,
        inpaintTextExpandPx: maskControls.inpaintTextExpandPx,
        inpaintBubbleScale: maskControls.inpaintBubbleScale,
        inpaintTextScale: maskControls.inpaintTextScale,
      }, authToken);

      onUpdate(p => ({ ...p, latest_job_id: created.job_id }));

      for (let attempt = 0; attempt < PIPELINE_POLL_MAX_ATTEMPTS; attempt++) {
        const status = await fetchPipelineJob(created.job_id, authToken);
        if (status.status === "done") {
          const serverRegions = await fetchPageRegions({ projectId: created.project_id, pageId: created.page_id }, authToken);
          const mapped = serverRegions.map(r => toEditorRegion({
            id: r.external_region_id, x: r.x, y: r.y, width: r.width, height: r.height,
            source_text: r.source_text, translated_text: r.translated_text, confidence: r.confidence,
          }));
          const regionMap = serverRegions.reduce<Record<string, string>>((acc, r) => { acc[r.external_region_id] = r.id; return acc; }, {});

          let maskRegions: MaskRegion[] = [];
          try {
            const resp = await previewMask({ file: page.file, provider: "custom", ...maskControls });
            maskRegions = resp.regions;
          } catch { /* optional */ }

          return { regions: mapped, maskRegions, projectId: created.project_id, pageId: created.page_id, regionMap };
        }
        if (status.status === "failed" || status.status === "canceled") {
          throw new Error(status.error_message || "Pipeline job failed");
        }
        await sleep(PIPELINE_POLL_INTERVAL_MS);
      }
      throw new Error("Pipeline timeout");
    } catch (e) {
      onUpdate(p => ({ ...p, pipeline_status: "error", pipeline_error: e instanceof Error ? e.message : "Pipeline error" }));
      return null;
    }
  }, []);

  const cancelJob = useCallback(async (jobId: string, authToken: string) => {
    return await cancelPipelineJob(jobId, authToken);
  }, []);

  return {
    editorMode, setEditorMode,
    activeStage, stageLoading,
    runDetect, runOcrStage, runTranslateStage, runCleanStage,
    runAutomatic, cancelJob,
  };
}
