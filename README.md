# Manga Translate Studio

Веб-приложение для semi-automatic перевода манги: загрузка страницы, детекция текстовых облаков, очистка/заливка, OCR, машинный перевод и ручная доработка в редакторе.

## Что реализовано
- Landing page с продуктовым позиционированием и архитектурой.
- Editor page: загрузка изображения, запуск пайплайна, редактирование результатов, экспорт JSON.
- Backend API (FastAPI):
  - Асинхронные pipeline job'ы через Redis очередь (`POST /api/v1/pipeline/jobs`, `GET /api/v1/pipeline/jobs/{job_id}`).
  - Worker (`python -m app.worker`) выполняет provider и сохраняет результат.
  - Контракт провайдера (`PipelineProvider`: detect/inpaint/ocr/translate).
  - Серверные сущности: `projects`, `pages`, `regions`, `job_runs`.
  - Автосохранение правок региона: `PATCH /api/v1/projects/{project_id}/pages/{page_id}/regions/{region_id}`.
  - Артефакты в MinIO (input/output ключи в БД + presigned URL).
  - JWT auth для новых защищённых endpoint'ов, idempotency по `request_id`/`X-Request-ID`.
  - Метрики Prometheus (`/metrics`) + request-id middleware + rate limit + MIME/magic-bytes/Pillow проверки.
  - Retry + dead-letter queue для неуспешных job'ов.
  - Readiness endpoint (`/ready`) с проверкой DB/Redis/S3.

## Стек
- Frontend: Next.js 15, TypeScript, Tailwind CSS.
- Backend: Python 3.11, FastAPI, Pydantic v2.
- Data: PostgreSQL (через Docker), MinIO (S3-compatible storage), Redis.
- Observability: Prometheus-ready metrics endpoint (заглушка), structured logging.

## Быстрый старт
```bash
cp .env.example .env

docker compose -f infra/docker-compose.yml up --build
```

Frontend: http://localhost:3000
API: http://localhost:8000/docs

## API quick reference
- `POST /api/v1/auth/dev-token` (dev only): получить JWT для локальной разработки.
- `POST /api/v1/storage/presign-upload`: получить signed URL для загрузки файла в MinIO.
- `GET /api/v1/storage/presign-download?key=...`: signed URL для скачивания артефакта.
- `POST /api/v1/pipeline/jobs`: создать async job.
  - поддерживает `file` (multipart) или `input_s3_key` (если файл уже загружен в MinIO).
  - для идемпотентности можно передавать `request_id` или header `X-Request-ID`.
- `GET /api/v1/pipeline/jobs/{job_id}`: получить статус/результат job.
- `PATCH /api/v1/projects/{project_id}/pages/{page_id}/regions/{region_id}`: сохранить правку региона.
- `GET /api/v1/projects/{project_id}/pages/{page_id}/artifacts`: получить presigned URL артефактов.
- `POST /api/v1/pipeline/run`: legacy sync endpoint (совместимость).
- `GET /metrics`: Prometheus метрики.
- `GET /ready`: readiness probe (DB/Redis/S3).

## Локальный запуск без Docker
### API
```bash
cd apps/api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### WEB
```bash
cd apps/web
npm install
npm run dev
```

## Архитектура
`apps/api/app/services/providers.py` содержит контракт провайдера и текущий `StubProvider`.

## Production baseline
- В `API_ENV=production` сервис валидирует runtime-настройки (`JWT_SECRET`, CORS, TTL signed URLs) и не стартует при небезопасной конфигурации.
- `JWT_SECRET` должен быть >= 32 символов и не дефолтным.
- Рекомендуется задавать `JWT_ISSUER` и `JWT_AUDIENCE` для строгой валидации токенов.
