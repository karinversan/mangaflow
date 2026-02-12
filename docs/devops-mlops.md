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
