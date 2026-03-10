export type Point = {
  x: number;
  y: number;
};

export type DetectedRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source_text: string;
  translated_text: string;
  confidence: number;
};

export type PipelineResponse = {
  image_width: number;
  image_height: number;
  regions: DetectedRegion[];
  inpaint_preview_url?: string;
};

export type MaskRegion = {
  id: string;
  label: "bubble" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  polygon?: Point[] | null;
};

export type MaskPreviewResponse = {
  image_width: number;
  image_height: number;
  regions: MaskRegion[];
};

export type PipelineJobCreateResponse = {
  job_id: string;
  status: "queued" | "running" | "retrying" | "done" | "failed" | "cancel_requested" | "canceled";
  project_id: string;
  page_id: string;
  request_id: string;
};

export type PipelineJobStatus = {
  job_id: string;
  project_id: string;
  page_id: string;
  status: "queued" | "running" | "retrying" | "done" | "failed" | "cancel_requested" | "canceled";
  request_id: string;
  target_lang: string;
  provider: string;
  detector_provider: string;
  detector_model: string;
  detector_version: string;
  inpainter_provider: string;
  inpainter_model: string;
  inpainter_version: string;
  ocr_provider: string;
  ocr_model: string;
  ocr_version: string;
  translator_provider: string;
  translator_model: string;
  translator_version: string;
  attempts: number;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  cancel_requested_at?: string | null;
  canceled_at?: string | null;
  error_message?: string | null;
  input_s3_key: string;
  mask_s3_key?: string | null;
  inpainted_s3_key?: string | null;
  output_json_s3_key?: string | null;
  output_preview_s3_key?: string | null;
  mask_url?: string | null;
  inpainted_url?: string | null;
  output_json_url?: string | null;
  output_preview_url?: string | null;
  region_count: number;
};

export type StageConfig = {
  provider: string;
  model?: string;
  version?: string;
  params?: Record<string, unknown>;
};

export type PipelineConfig = {
  detector?: StageConfig;
  inpainter?: StageConfig;
  ocr?: StageConfig;
  translator?: StageConfig;
};

export type ProjectProgress = {
  project_id: string;
  total_pages: number;
  queued: number;
  running: number;
  retrying: number;
  done: number;
  failed: number;
  canceled: number;
  processed_pages: number;
};

export type ProviderHealth = {
  provider: string;
  ready: boolean;
  latency_ms: number;
  error_rate: number;
  checks: Record<string, unknown>;
};

export type ProviderInfo = {
  name: string;
  enabled: boolean;
  stages: string[];
  model: string;
  version: string;
  capabilities: string[];
  health: ProviderHealth;
};
