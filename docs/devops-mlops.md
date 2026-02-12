# DevOps & MLOps Plan

## DevOps
- Containerized services (`infra/docker-compose.yml`) for reproducible local env.
- CI pipeline:
  - Web typecheck + build
  - API compile check
- Next step:
  - Add tests (unit + integration + e2e)
  - Add lint + formatting gates
  - Add deployment pipeline (staging/prod)

## Observability
- `/health` and `/metrics` endpoints already present.
- Next:
  - OpenTelemetry tracing (web -> api -> worker)
  - Structured logs to Loki/ELK
  - Metrics dashboard (Prometheus + Grafana)
  - Alerting SLO for pipeline latency/error-rate

## Local workflow
- The stack boots via `infra/docker-compose.yml`, so `web`, `api`, `postgres`, `redis`, and `minio` all come up aligned. Keep `.env` in sync with `.env.example`.
- `apps/api` expects `DATABASE_URL`, `REDIS_URL`, and the MinIO credentials in the compose file; edit `NEXT_PUBLIC_API_URL` if you want the frontend to hit another API host.
- Run `docker compose logs -f web api` while exercising the editor and `docker compose exec api python -m pytest` after adding tests.
- For rapid iterations, use `uvicorn app.main:app --reload --port 8000` from `apps/api` and `npm run dev` from `apps/web` so both servers restart quickly without rebuilds.

## Deployment checklist
- Tear down with `docker compose -f infra/docker-compose.yml down --remove-orphans` before pushing to avoid stale networks and ports.
- When introducing database migrations, add them to `apps/api/app/db/models.py` and document `alembic`/`gorm` steps here before bumping schema versions.
- Swap `pipeline_stub.py` for the production ML adapter only after the interface contract (image + target language -> region list with confidence) is stable.
- Tag releases (e.g., `v0.1.0`) and keep `apps/web/src/app/layout.tsx` metadata aligned with marketing copy so landing page titles match official launches.

## MLOps integration roadmap
1. Data pipeline
- Store training samples and annotation exports in versioned bucket.
- Dataset manifest with version id.

2. Experiment tracking
- Add MLflow tracking server.
- Log model metrics (detector IoU, OCR CER/WER, translation BLEU/COMET).

3. Model registry & rollout
- Register model versions (staging/production aliases).
- Canary release by traffic split.
- Automatic rollback by quality guardrails.

4. Serving contract
- Keep API stable:
  - input: page image + target language
  - output: region boxes + text + confidence
- Plug real model service under current stub adapter (`pipeline_stub.py` -> `pipeline_service.py`).
