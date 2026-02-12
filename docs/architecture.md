# Architecture

## Product scope (MVP)
- Landing page (позиционирование, архитектура, CTA).
- Editor page (upload -> detect -> inpaint preview -> OCR text -> translation -> manual review -> export JSON).
- API contract, совместимый с будущей реальной ML моделью.

## Components
1. Web App (`apps/web`)
- Next.js App Router.
- Pages: `/` (landing), `/editor`.
- Calls `POST /api/v1/pipeline/run`.
- Редактор хранит изменения локально в состоянии, экспортирует JSON.

2. API (`apps/api`)
- FastAPI, endpoint `/api/v1/pipeline/run`.
- Проверка входа (content-type, size limits).
- Stub pipeline service:
  - Text region detection (fake deterministic boxes)
  - Inpaint stage (placeholder)
  - OCR stage (mock source phrases)
  - Translation stage (dictionary mock)

3. Data & Infra
- PostgreSQL: metadata проектов, пользователей, версий.
- MinIO(S3): исходники и промежуточные артефакты.
- Redis: queue/cache/rate-limiter backend.

## Data flow
- Landing page uploads an image to `/api/v1/pipeline/run` via `runPipeline`; the API forwards the file and `target_lang` to the stub adapter.
- `run_stub_pipeline` synthesizes deterministic boxes, inpaint/noise placeholders, OCR phrases, and translated text that mirrors the contract future ML models must maintain.
- Each submission is recorded in `pipeline_runs`, so the editor can show history and exports while QA retains the same region schema downstream.

## Target domain model (next increment)
- `users`
- `projects`
- `pages`
- `regions`
- `translations`
- `pipeline_runs`

## API contract principles
- Stable response schema for region blocks.
- Percent coordinates (`x,y,width,height`) to keep UI model-resolution independent.
- Explicit confidence to support human QA workflow.

## Scaling strategy
- Split pipeline into async jobs (Celery/RQ worker + Redis).
- Separate model-serving process (GPU node) behind dedicated `/pipeline` adapter.
- Use object storage for immutable page assets and versioned outputs.
