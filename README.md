# Manga Translate Studio

Веб-приложение для semi-automatic перевода манги: загрузка страницы, детекция текстовых облаков, очистка/заливка, OCR, машинный перевод и ручная доработка в редакторе.

## Что реализовано
- Landing page с продуктовым позиционированием и архитектурой.
- Editor page: загрузка изображения, запуск пайплайна, редактирование результатов, экспорт JSON.
- Backend API (FastAPI): заглушка ML пайплайна (detect/inpaint/ocr/translate).
- Базовый security baseline, DevOps и MLOps каркас.

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

## Operations reference
- Detailed DevOps/MLOps plan and local workflow are tracked in `docs/devops-mlops.md`.
- Architecture, API contract, and scaling guidance live in `docs/architecture.md`.

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
См. `/docs/architecture.md`, `/docs/security.md`, `/docs/devops-mlops.md`.
