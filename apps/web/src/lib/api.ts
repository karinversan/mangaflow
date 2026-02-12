import { PipelineJobCreateResponse, PipelineJobStatus, PipelineResponse } from "@/lib/types";

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
  },
  token: string
): Promise<PipelineJobCreateResponse> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("target_lang", params.targetLang);
  form.append("provider", params.provider || "stub");
  if (params.requestId) form.append("request_id", params.requestId);
  if (params.projectId) form.append("project_id", params.projectId);
  if (params.projectName) form.append("project_name", params.projectName);
  if (typeof params.pageIndex === "number") form.append("page_index", String(params.pageIndex));

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

export async function fetchPipelineRuns(): Promise<PipelineRunItem[]> {
  const res = await fetch(`${API_URL}/api/v1/pipeline/runs`, {
    method: "GET",
    cache: "no-store"
  });

  if (!res.ok) {
    throw new Error("Failed to fetch pipeline history");
  }

  return (await res.json()) as PipelineRunItem[];
}
