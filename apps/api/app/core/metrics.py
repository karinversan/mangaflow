from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

pipeline_requests_total = Counter("pipeline_requests_total", "Pipeline requests total.")
pipeline_errors_total = Counter("pipeline_errors_total", "Pipeline errors total.")
pipeline_job_duration_seconds = Histogram("pipeline_job_duration_seconds", "Pipeline job execution duration seconds.")
pipeline_queue_length = Gauge("pipeline_queue_length", "Pipeline queue length.")
pipeline_jobs_running = Gauge("pipeline_jobs_running", "Pipeline jobs currently running.")
pipeline_retries_total = Counter("pipeline_retries_total", "Pipeline retry attempts.")
pipeline_dead_letter_total = Counter("pipeline_dead_letter_total", "Pipeline dead-lettered jobs.")
pipeline_stage_duration_seconds = Histogram(
    "pipeline_stage_duration_seconds",
    "Pipeline stage duration seconds by provider.",
    labelnames=("stage", "provider"),
)
pipeline_stage_failures_total = Counter(
    "pipeline_stage_failures_total",
    "Pipeline stage failures by provider.",
    labelnames=("stage", "provider"),
)
pipeline_workers_active = Gauge("pipeline_workers_active", "Active worker processes.")

http_requests_total = Counter(
    "http_requests_total",
    "HTTP requests total.",
    labelnames=("method", "path", "status"),
)
http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration seconds.",
    labelnames=("method", "path"),
)
http_requests_in_flight = Gauge("http_requests_in_flight", "HTTP in-flight requests.")


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
