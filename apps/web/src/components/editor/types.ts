import { DetectedRegion, MaskRegion, PipelineConfig, ProjectProgress, ProviderInfo, Point, DetectRegion } from "@/lib/types";

export type ReviewStatus = "todo" | "edited" | "approved";
export type FilterMode = "all" | "todo" | "edited" | "approved" | "low_confidence" | "empty";
export type ToolMode = "select" | "pan" | "zoom";
export type EditorMode = "manual" | "automatic";

export type EditorRegion = DetectedRegion & {
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

export type ImageMeta = {
  width: number;
  height: number;
};

export type PageDoc = {
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

export type MaskControls = {
  inpaintBubbleExpandPx: number;
  inpaintTextExpandPx: number;
  inpaintBubbleScale: number;
  inpaintTextScale: number;
};

export const DEFAULT_MASK_CONTROLS: MaskControls = {
  inpaintBubbleExpandPx: 8,
  inpaintTextExpandPx: 3,
  inpaintBubbleScale: 1.03,
  inpaintTextScale: 1,
};
