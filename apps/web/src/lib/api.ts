import { PipelineResponse } from "@/lib/types";

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
