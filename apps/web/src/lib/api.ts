import {
  CleanResponse,
  DetectRegion,
  DetectResponse,
  MaskPreviewResponse,
  MaskRegion,
  OcrResponse,
  PipelineConfig,
  PipelineJobCreateResponse,
  PipelineJobStatus,
  PipelineResponse,
  ProjectProgress,
  ProviderInfo
} from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export type PipelineRunItem = {
  id: string;
  file_name: string;
  target_lang: string;
  region_count: number;
  created_at: string;
};

export async function runPipeline(file: File, targetLang: string): Promise<PipelineResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("target_lang", targetLang);

  const res = await fetch(`${API_URL}/api/v1/pipeline/run`, {
    method: "POST",
    body: form
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Pipeline request failed");
  }

  return (await res.json()) as PipelineResponse;
}

function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function createPipelineJob(
  params: {
    file: File;
    targetLang: string;
    requestId?: string;
    provider?: "stub" | "huggingface" | "custom";
    projectId?: string;
    projectName?: string;
    pageIndex?: number;
    inpaintBubbleExpandPx?: number;
    inpaintTextExpandPx?: number;
    inpaintBubbleScale?: number;
    inpaintTextScale?: number;
    pipelineConfig?: PipelineConfig;
  },
  token: string
): Promise<PipelineJobCreateResponse> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("target_lang", params.targetLang);
  form.append("provider", params.provider || "custom");
  if (params.requestId) form.append("request_id", params.requestId);
  if (params.projectId) form.append("project_id", params.projectId);
  if (params.projectName) form.append("project_name", params.projectName);
  if (typeof params.pageIndex === "number") form.append("page_index", String(params.pageIndex));
  if (typeof params.inpaintBubbleExpandPx === "number") form.append("inpaint_bubble_expand_px", String(params.inpaintBubbleExpandPx));
  if (typeof params.inpaintTextExpandPx === "number") form.append("inpaint_text_expand_px", String(params.inpaintTextExpandPx));
  if (typeof params.inpaintBubbleScale === "number") form.append("inpaint_bubble_scale", String(params.inpaintBubbleScale));
  if (typeof params.inpaintTextScale === "number") form.append("inpaint_text_scale", String(params.inpaintTextScale));
  if (params.pipelineConfig) form.append("pipeline_config_json", JSON.stringify(params.pipelineConfig));

  const res = await fetch(`${API_URL}/api/v1/pipeline/jobs`, {
    method: "POST",
    headers: authHeaders(token),
    body: form
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to create pipeline job");
  }
  return (await res.json()) as PipelineJobCreateResponse;
}

export async function fetchPipelineJob(jobId: string, token: string): Promise<PipelineJobStatus> {
  const res = await fetch(`${API_URL}/api/v1/pipeline/jobs/${jobId}`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch job status");
  }
  return (await res.json()) as PipelineJobStatus;
}

export async function patchRegion(
  params: {
    projectId: string;
    pageId: string;
    regionId: string;
    patch: Partial<{
      translated_text: string;
      review_status: "todo" | "edited" | "approved";
      note: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  },
  token: string
): Promise<void> {
  const res = await fetch(
    `${API_URL}/api/v1/projects/${params.projectId}/pages/${params.pageId}/regions/${params.regionId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token)
      },
      body: JSON.stringify(params.patch)
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to save region");
  }
}

export type ServerRegion = {
  id: string;
  external_region_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source_text: string;
  translated_text: string;
  confidence: number;
  review_status: "todo" | "edited" | "approved";
  note: string;
  updated_at: string;
};

export async function fetchPageRegions(
  params: { projectId: string; pageId: string },
  token: string
): Promise<ServerRegion[]> {
  const res = await fetch(`${API_URL}/api/v1/projects/${params.projectId}/pages/${params.pageId}/regions`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch page regions");
  }
  return (await res.json()) as ServerRegion[];
}

export async function getPageArtifacts(
  params: { projectId: string; pageId: string },
  token: string
): Promise<{ input_url: string; output_json_url?: string | null; output_preview_url?: string | null }> {
  const res = await fetch(`${API_URL}/api/v1/projects/${params.projectId}/pages/${params.pageId}/artifacts`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch page artifacts");
  }
  return (await res.json()) as { input_url: string; output_json_url?: string | null; output_preview_url?: string | null };
}

export async function fetchPageInput(
  params: { projectId: string; pageId: string },
  token: string
): Promise<Blob> {
  const res = await fetch(`${API_URL}/api/v1/projects/${params.projectId}/pages/${params.pageId}/input`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch page input");
  }
  return await res.blob();
}

export async function fetchPagePreview(
  params: { projectId: string; pageId: string },
  token: string
): Promise<Blob> {
  const res = await fetch(`${API_URL}/api/v1/projects/${params.projectId}/pages/${params.pageId}/preview`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch page preview");
  }
  return await res.blob();
}

export async function issueDevToken(userId: string, email?: string): Promise<string> {
  const form = new FormData();
  form.append("user_id", userId);
  if (email) form.append("email", email);

  const res = await fetch(`${API_URL}/api/v1/auth/dev-token`, {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to issue dev token");
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

export async function fetchLastSession(
  token: string
): Promise<{ project_id?: string | null; page_id?: string | null; file_name?: string | null; view_params?: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/api/v1/me/last-session`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch last session");
  }
  return (await res.json()) as { project_id?: string | null; page_id?: string | null; file_name?: string | null; view_params?: Record<string, unknown> };
}

export async function upsertLastSession(
  params: { project_id?: string | null; page_id?: string | null; file_name?: string | null; view_params?: Record<string, unknown> },
  token: string
): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/me/last-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token)
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to upsert last session");
  }
}

export async function presignUpload(
  params: { fileName: string; contentType: string },
  token: string
): Promise<{ key: string; url: string; expires_in_sec: number }> {
  const form = new FormData();
  form.append("file_name", params.fileName);
  form.append("content_type", params.contentType);
  const res = await fetch(`${API_URL}/api/v1/storage/presign-upload`, {
    method: "POST",
    headers: authHeaders(token),
    body: form
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to presign upload URL");
  }
  return (await res.json()) as { key: string; url: string; expires_in_sec: number };
}

export async function presignDownload(
  key: string,
  token: string
): Promise<{ key: string; url: string; expires_in_sec: number }> {
  const url = new URL(`${API_URL}/api/v1/storage/presign-download`);
  url.searchParams.set("key", key);
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to presign download URL");
  }
  return (await res.json()) as { key: string; url: string; expires_in_sec: number };
}

export async function fetchPipelineRuns(token?: string): Promise<PipelineRunItem[]> {
  const res = await fetch(`${API_URL}/api/v1/pipeline/runs`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("Failed to fetch pipeline history");
  }

  return (await res.json()) as PipelineRunItem[];
}

export async function previewMask(params: {
  file: File;
  provider?: "stub" | "huggingface" | "custom";
  inpaintBubbleExpandPx?: number;
  inpaintTextExpandPx?: number;
  inpaintBubbleScale?: number;
  inpaintTextScale?: number;
}): Promise<MaskPreviewResponse> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("provider", params.provider || "custom");
  if (typeof params.inpaintBubbleExpandPx === "number") form.append("inpaint_bubble_expand_px", String(params.inpaintBubbleExpandPx));
  if (typeof params.inpaintTextExpandPx === "number") form.append("inpaint_text_expand_px", String(params.inpaintTextExpandPx));
  if (typeof params.inpaintBubbleScale === "number") form.append("inpaint_bubble_scale", String(params.inpaintBubbleScale));
  if (typeof params.inpaintTextScale === "number") form.append("inpaint_text_scale", String(params.inpaintTextScale));

  const res = await fetch(`${API_URL}/api/v1/pipeline/mask-preview`, {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to preview mask");
  }
  return (await res.json()) as MaskPreviewResponse;
}

export async function previewInpaint(params: { file: File; regions: MaskRegion[] }): Promise<Blob> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("regions_json", JSON.stringify(params.regions));
  const res = await fetch(`${API_URL}/api/v1/pipeline/inpaint-preview`, {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to inpaint preview");
  }
  return await res.blob();
}

export async function translateTexts(params: {
  provider?: "stub" | "huggingface" | "custom";
  targetLang: string;
  texts: string[];
}): Promise<string[]> {
  const res = await fetch(`${API_URL}/api/v1/pipeline/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: params.provider || "custom",
      target_lang: params.targetLang,
      texts: params.texts
    })
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to translate texts");
  }
  const payload = (await res.json()) as { translated_texts: string[] };
  return payload.translated_texts;
}

export async function cancelPipelineJob(jobId: string, token: string): Promise<{ job_id: string; status: string }> {
  const res = await fetch(`${API_URL}/api/v1/pipeline/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: authHeaders(token)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to cancel job");
  }
  return (await res.json()) as { job_id: string; status: string };
}

export async function fetchProjectProgress(projectId: string, token: string): Promise<ProjectProgress> {
  const res = await fetch(`${API_URL}/api/v1/projects/${projectId}/progress`, {
    method: "GET",
    headers: authHeaders(token),
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch project progress");
  }
  return (await res.json()) as ProjectProgress;
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${API_URL}/api/v1/providers`, {
    method: "GET",
    cache: "no-store"
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to fetch providers");
  }
  return (await res.json()) as ProviderInfo[];
}

export async function exportProjectZip(projectId: string, token: string): Promise<Blob> {
  const res = await fetch(`${API_URL}/api/v1/projects/${projectId}/export.zip`, {
    method: "GET",
    headers: authHeaders(token)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Failed to export project zip");
  }
  return await res.blob();
}

// ---------------------------------------------------------------------------
// Per-stage API functions
// ---------------------------------------------------------------------------

export async function detectTextBoxes(
  file: File,
  provider: string = "custom"
): Promise<DetectResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("provider", provider);
  const res = await fetch(`${API_URL}/api/v1/pipeline/detect`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Detection failed");
  }
  return (await res.json()) as DetectResponse;
}

export async function runOcr(
  file: File,
  regions: DetectRegion[],
  provider: string = "custom"
): Promise<OcrResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("regions_json", JSON.stringify(regions));
  form.append("provider", provider);
  const res = await fetch(`${API_URL}/api/v1/pipeline/ocr`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "OCR failed");
  }
  return (await res.json()) as OcrResponse;
}

export async function cleanImage(
  file: File,
  regions: MaskRegion[],
  provider: string = "custom"
): Promise<CleanResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("regions_json", JSON.stringify(regions));
  form.append("provider", provider);
  const res = await fetch(`${API_URL}/api/v1/pipeline/clean`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || "Cleaning failed");
  }
  return (await res.json()) as CleanResponse;
}
