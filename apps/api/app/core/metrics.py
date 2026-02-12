from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

pipeline_requests_total = Counter("pipeline_requests_total", "Pipeline requests total.")
pipeline_errors_total = Counter("pipeline_errors_total", "Pipeline errors total.")
pipeline_job_duration_seconds = Histogram("pipeline_job_duration_seconds", "Pipeline job execution duration seconds.")
pipeline_queue_length = Gauge("pipeline_queue_length", "Pipeline queue length.")
pipeline_jobs_running = Gauge("pipeline_jobs_running", "Pipeline jobs currently running.")


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
