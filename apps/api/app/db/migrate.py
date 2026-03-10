from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine


def _safe_execute(conn, sql: str) -> None:
    try:
        conn.execute(text(sql))
    except Exception:
        # Incremental/local migration helper: tolerate already-applied or unsupported DDL variants.
        pass


def run_migrations(engine: Engine) -> None:
    dialect = engine.dialect.name
    with engine.begin() as conn:
        if dialect == "postgresql":
            _safe_execute(conn, "ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64)")
            _safe_execute(conn, "UPDATE projects SET created_by = owner_id WHERE created_by IS NULL")
            _safe_execute(conn, "UPDATE projects SET updated_by = owner_id WHERE updated_by IS NULL")

            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS created_by VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS updated_by VARCHAR(64)")
            _safe_execute(conn, "UPDATE job_runs SET created_by = owner_id WHERE created_by IS NULL")
            _safe_execute(conn, "UPDATE job_runs SET updated_by = owner_id WHERE updated_by IS NULL")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS status_reason TEXT")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS mask_s3_key VARCHAR(512)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS inpainted_s3_key VARCHAR(512)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS detector_provider VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS detector_model VARCHAR(128)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS detector_version VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS detector_params_json TEXT")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS inpainter_provider VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS inpainter_model VARCHAR(128)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS inpainter_version VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS inpainter_params_json TEXT")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS ocr_provider VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS ocr_model VARCHAR(128)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS ocr_version VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS ocr_params_json TEXT")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS translator_provider VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS translator_model VARCHAR(128)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS translator_version VARCHAR(64)")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS translator_params_json TEXT")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ")
            _safe_execute(conn, "ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ")
            _safe_execute(conn, "UPDATE job_runs SET detector_provider = COALESCE(detector_provider, provider)")
            _safe_execute(conn, "UPDATE job_runs SET detector_model = COALESCE(detector_model, 'default')")
            _safe_execute(conn, "UPDATE job_runs SET detector_version = COALESCE(detector_version, 'v1')")
            _safe_execute(conn, "UPDATE job_runs SET detector_params_json = COALESCE(detector_params_json, '{}')")
            _safe_execute(conn, "UPDATE job_runs SET inpainter_provider = COALESCE(inpainter_provider, provider)")
            _safe_execute(conn, "UPDATE job_runs SET inpainter_model = COALESCE(inpainter_model, 'default')")
            _safe_execute(conn, "UPDATE job_runs SET inpainter_version = COALESCE(inpainter_version, 'v1')")
            _safe_execute(conn, "UPDATE job_runs SET inpainter_params_json = COALESCE(inpainter_params_json, '{}')")
            _safe_execute(conn, "UPDATE job_runs SET ocr_provider = COALESCE(ocr_provider, provider)")
            _safe_execute(conn, "UPDATE job_runs SET ocr_model = COALESCE(ocr_model, 'default')")
            _safe_execute(conn, "UPDATE job_runs SET ocr_version = COALESCE(ocr_version, 'v1')")
            _safe_execute(conn, "UPDATE job_runs SET ocr_params_json = COALESCE(ocr_params_json, '{}')")
            _safe_execute(conn, "UPDATE job_runs SET translator_provider = COALESCE(translator_provider, provider)")
            _safe_execute(conn, "UPDATE job_runs SET translator_model = COALESCE(translator_model, 'default')")
            _safe_execute(conn, "UPDATE job_runs SET translator_version = COALESCE(translator_version, 'v1')")
            _safe_execute(conn, "UPDATE job_runs SET translator_params_json = COALESCE(translator_params_json, '{}')")

        _safe_execute(
            conn,
            """
            CREATE TABLE IF NOT EXISTS job_events (
                id VARCHAR(36) PRIMARY KEY,
                job_id VARCHAR(36) NOT NULL,
                status VARCHAR(24) NOT NULL,
                message TEXT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL
            )
            """,
        )
        _safe_execute(
            conn,
            """
            CREATE TABLE IF NOT EXISTS user_sessions (
                user_id VARCHAR(64) PRIMARY KEY,
                project_id VARCHAR(36) NULL,
                page_id VARCHAR(36) NULL,
                file_name VARCHAR(255) NULL,
                view_params_json TEXT NOT NULL DEFAULT '{}',
                created_at TIMESTAMP WITH TIME ZONE NOT NULL,
                updated_at TIMESTAMP WITH TIME ZONE NOT NULL
            )
            """,
        )
