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

export type PipelineJobCreateResponse = {
  job_id: string;
  status: "queued" | "running" | "done" | "failed";
  project_id: string;
  page_id: string;
  request_id: string;
};

export type PipelineJobStatus = {
  job_id: string;
  project_id: string;
  page_id: string;
  status: "queued" | "running" | "done" | "failed";
  request_id: string;
  target_lang: string;
  provider: string;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
  input_s3_key: string;
  output_json_s3_key?: string | null;
  output_preview_s3_key?: string | null;
  output_json_url?: string | null;
  output_preview_url?: string | null;
  region_count: number;
};
