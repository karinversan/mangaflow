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
