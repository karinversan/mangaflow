<p align="center">
  <img src="apps/web/public/logo.svg" alt="MangaFlow" width="80" />
</p>

<h1 align="center">MangaFlow</h1>

<p align="center">
  Платформа для автоматизированного перевода манги с японского на другие языки.<br/>
  Детекция текстовых областей, OCR, машинный перевод, инпейнтинг и ручная редактура — в одном инструменте.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.12-blue" />
  <img src="https://img.shields.io/badge/Next.js-15-black" />
  <img src="https://img.shields.io/badge/FastAPI-0.115-green" />
  <img src="https://img.shields.io/badge/YOLO-v11--seg-orange" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" />
</p>

---

## 📖 О проекте

**MangaFlow** — веб-приложение для перевода манги, построенное как end-to-end ML-пайплайн: от загрузки страницы до экспорта переведённого изображения. Проект сочетает кастомную YOLO-модель для сегментации текстовых областей, MangaOCR для распознавания японского текста, LLM-перевод через OpenRouter и SimpleLama для инпейнтинга (удаления текста с фона).

### Мотивация

Существующие инструменты перевода манги (например, [comic-translate](https://github.com/ogkalu2/comic-translate)) — десктопные приложения. MangaFlow — это **веб-платформа** с пошаговым пайплайном, редактором полигонов, асинхронными очередями и персистентностью сессий, ориентированная на удобство и масштабируемость.

### Ключевые особенности

- **5-стадийный пайплайн**: Detect → OCR → Translate → Clean → Render
- **Кастомная YOLO-модель** (YOLOv11s-seg), обученная на самостоятельно размеченном датасете манги
- **Интерактивный редактор** с возможностью двигать точки полигонов, удалять регионы, корректировать перевод
- **Асинхронная обработка** через Redis очереди с retry-логикой и dead-letter queue
- **Персистентность** — работа сохраняется между перезагрузками страницы
- **Docker Compose** — запуск всего стека одной командой

---

## 🏗️ Архитектура

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Next.js 15    │────▶│   FastAPI API     │────▶│  PostgreSQL │
│   React 19      │     │   + Worker        │     └─────────────┘
│   Tailwind CSS  │     │                   │────▶┌─────────────┐
└─────────────────┘     │   Python 3.12     │     │    Redis     │
                        │                   │────▶└─────────────┘
                        │   ML Models:      │────▶┌─────────────┐
                        │   YOLO, MangaOCR, │     │    MinIO     │
                        │   SimpleLama,     │     │  (artifacts) │
                        │   OpenRouter LLM  │     └─────────────┘
                        └──────────────────┘
```

### Стек технологий

| Слой | Технологии |
|------|-----------|
| **Frontend** | Next.js 15, React 19, TypeScript, Tailwind CSS |
| **Backend** | FastAPI, SQLAlchemy, Pydantic v2, Uvicorn |
| **ML / AI** | YOLOv11s-seg (ultralytics), MangaOCR, SimpleLama, OpenRouter API |
| **Инфраструктура** | Docker Compose, PostgreSQL 15, Redis 7, MinIO |
| **Мониторинг** | Prometheus metrics (`/metrics`), structured logging |

---

## 🤖 ML-пайплайн

### 1. Детекция текстовых областей (YOLO Segmentation)

Используется модель **YOLOv11s-seg** (10.4M параметров, 34.1 GFLOPs), дообученная на кастомном датасете.

**Датасет**:
- Собран с [Roboflow](https://universe.roboflow.com/test-4au37/manga_transl/dataset/1)
- **Разметка выполнена вручную** — полигональная сегментация текстовых областей
- 5 классов: `bubble_text`, `narrative_text`, `background_text`, `meta_text`, `sfx`
- Train / Val / Test split

**Метрики на тестовой выборке** (10 изображений, 160 аннотаций):

| Метрика | Box | Mask |
|---------|-----|------|
| **mAP@50** | 0.374 | 0.394 |
| **mAP@50-95** | 0.285 | 0.264 |
| **Precision** | 0.450 | 0.453 |
| **Recall** | 0.290 | 0.299 |

**Pixel-level метрики (Dice / IoU)**:

| Класс | Dice | IoU | Изображений |
|-------|------|-----|-------------|
| bubble_text | **0.784** | **0.667** | 8 |
| sfx | 0.385 | 0.319 | 8 |
| background_text | 0.023 | 0.012 | 5 |
| meta_text | 0.010 | 0.005 | 4 |
| narration_text | 0.000 | 0.000 | 2 |
| **Среднее** | **0.240** | **0.200** | — |

> **Примечание**: Модель хорошо справляется с основным классом `bubble_text` (Dice 0.78). Низкие показатели редких классов (`meta_text`, `narration_text`) связаны с малым количеством примеров в тестовой выборке и дисбалансом классов. Дальнейшее улучшение возможно за счёт расширения датасета.

### 2. OCR (MangaOCR)

[MangaOCR](https://github.com/kha-white/manga-ocr) — модель на базе Vision Encoder-Decoder, специализированная на распознавании японского текста в манге. Работает без внешних API, полностью локально.

### 3. Перевод (OpenRouter LLM)

Перевод выполняется через [OpenRouter API](https://openrouter.ai/) с использованием LLM-модели. По умолчанию используется `openrouter/hunter-alpha`. Поддерживаемые языки: русский, английский, испанский, корейский, китайский и другие.

### 4. Инпейнтинг (SimpleLama)

[SimpleLama](https://github.com/enesmsahin/simple-lama-inpainting) — обёртка над LaMa (Large Mask Inpainting). Удаляет текст с изображения, восстанавливая фон под текстовыми областями. Используются полигональные маски из стадии детекции.

---

## 🚀 Быстрый старт

### Docker Compose (рекомендуется)

```bash
git clone https://github.com/karinversan/manga-translate-project.git
cd manga-translate-project

# Настройка
cp .env.example .env
# Отредактируйте .env — укажите OPENROUTER_API_KEY

# Поместите модель
mkdir -p apps/api/models
cp ~/Downloads/best.pt apps/api/models/best.pt

# Запуск
docker compose -f infra/docker-compose.yml up -d
```

- 🌐 Web: http://localhost:3300
- 📖 API docs: http://localhost:8100/docs

### Локальная разработка (без Docker)

```bash
# Backend
cd apps/api
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install --no-deps simple-lama-inpainting==0.1.2
OPENROUTER_API_KEY="your-key" python -m uvicorn app.main:app --reload --port 8000

# Frontend (в другом терминале)
cd apps/web
npm install
npm run dev
```

---

## 📁 Структура проекта

```
manga-translate-project/
├── apps/
│   ├── api/                    # FastAPI backend + ML pipeline
│   │   ├── app/
│   │   │   ├── api/routes.py   # API endpoints
│   │   │   ├── core/config.py  # Настройки (Pydantic Settings)
│   │   │   ├── services/
│   │   │   │   ├── providers.py        # ML-провайдеры (YOLO, OCR, LLM, Lama)
│   │   │   │   ├── pipeline_service.py # Оркестрация пайплайна
│   │   │   │   └── job_queue.py        # Redis очередь
│   │   │   └── db/             # SQLAlchemy модели
│   │   ├── models/             # YOLO .pt веса (не в git)
│   │   └── requirements.txt
│   └── web/                    # Next.js frontend
│       └── src/
│           ├── app/
│           │   ├── page.tsx            # Лендинг
│           │   └── editor/page.tsx     # Страница редактора
│           ├── components/
│           │   └── EditorWorkbench.tsx  # Основной компонент редактора
│           └── lib/
│               ├── api.ts              # API клиент
│               └── types.ts            # TypeScript типы
├── infra/
│   └── docker-compose.yml      # Полный стек
├── scripts/
│   ├── evaluate_pipeline.py    # Скрипт оценки моделей
│   └── reports/                # JSON-отчёты с метриками
├── manga_pipeline_notebooks/
│   └── dataset/                # YOLO-датасет (Roboflow)
├── .env.example
└── README.md
```

---

## 🔧 API Endpoints

### Pipeline (поэтапный)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `POST` | `/api/v1/pipeline/detect` | Детекция текстовых областей |
| `POST` | `/api/v1/pipeline/ocr` | OCR распознавание |
| `POST` | `/api/v1/pipeline/translate` | Перевод текстов |
| `POST` | `/api/v1/pipeline/clean` | Инпейнтинг (очистка фона) |

### Pipeline (полный цикл)

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `POST` | `/api/v1/pipeline/jobs` | Создать задачу полного пайплайна |
| `GET` | `/api/v1/pipeline/jobs/{id}` | Статус задачи |
| `POST` | `/api/v1/pipeline/jobs/{id}/cancel` | Отмена задачи |

### Проекты и сессии

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/api/v1/projects/{id}/progress` | Прогресс проекта |
| `GET` | `/api/v1/projects/{id}/export.zip` | Экспорт проекта |
| `GET/POST` | `/api/v1/me/last-session` | Восстановление сессии |

---

## 📊 Скрипты оценки

```bash
# Оценка сегментации (mAP, Dice, IoU)
python scripts/evaluate_pipeline.py segment-eval \
  --data-yaml manga_pipeline_notebooks/dataset/data_eval.yaml \
  --model-path apps/api/models/best.pt \
  --split test

# Генерация OCR-разметки для ручной проверки
python scripts/evaluate_pipeline.py ocr-label \
  --images-dir manga_pipeline_notebooks/dataset/test/images \
  --model-path apps/api/models/best.pt

# Полный бенчмарк пайплайна
python scripts/evaluate_pipeline.py full-benchmark \
  --images-dir manga_pipeline_notebooks/dataset/test/images \
  --model-path apps/api/models/best.pt \
  --skip-translate
```

---

## 🔐 Безопасность

- JWT-аутентификация на всех endpoint'ах проектов/задач
- Проверка владельца при доступе к проектам/страницам/регионам
- Валидация загрузок: MIME-тип, magic bytes, лимиты размера и пикселей
- Rate limiting для чувствительных endpoint'ов

---

## 🗺️ Roadmap

- [ ] Расширение датасета для улучшения детекции редких классов
- [ ] Fine-tuning MangaOCR на вертикальном тексте
- [ ] Поддержка пакетной обработки (несколько страниц)
- [ ] Экспорт в PDF/EPUB
- [ ] Kubernetes deployment
- [ ] Distributed tracing (OpenTelemetry)

---

## 📄 Лицензия

MIT

---

<p align="center">
  <b>MangaFlow</b> — разработано как портфолио-проект для демонстрации full-stack ML pipeline.
</p>
