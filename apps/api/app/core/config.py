from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_env: str = "development"
    cors_allow_origins: str = "http://localhost:3000"
    max_upload_mb: int = 25
    max_image_pixels: int = 30_000_000
    database_url: str = "sqlite:///./manga_translate.db"
    redis_url: str = "redis://localhost:6379/0"
    pipeline_queue_name: str = "pipeline:jobs"
    pipeline_dead_letter_queue_name: str = "pipeline:jobs:dead-letter"
    pipeline_max_attempts: int = 3
    pipeline_job_timeout_sec: int = 120
    pipeline_stale_running_sec: int = 180
    pipeline_retry_count: int = 2
    pipeline_circuit_failure_threshold: int = 5
    pipeline_circuit_reset_sec: int = 60
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_issuer: str | None = None
    jwt_audience: str | None = None
    jwt_access_ttl_sec: int = 3600
    jwt_leeway_sec: int = 30
    storage_backend: str = "local"  # "local" for dev, "s3" for production
    local_storage_path: str = ".storage"
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "manga-pages"
    s3_region: str = "us-east-1"
    signed_url_expires_sec: int = 900
    rate_limit_per_minute: int = 60
    request_log_enabled: bool = True
    enable_ready_checks: bool = True
    model_runtime_device: str = "auto"
    detection_yolo_model_path: str = "models/best.pt"
    detection_allowed_labels: str = "bubble_text,narrative_text,sfx,background_text,meta_text"
    detection_conf_threshold: float = 0.25
    detection_iou_threshold: float = 0.45
    inpaint_bubble_expand_px: int = 8
    inpaint_text_expand_px: int = 3
    inpaint_bubble_scale: float = 1.03
    inpaint_text_scale: float = 1.0
    ocr_languages: str = "ja,en"
    translation_model_id: str = "facebook/nllb-200-distilled-600M"
    translation_source_lang: str = "jpn_Jpan"
    translation_batch_size: int = 4
    translation_max_input_length: int = 256
    translation_max_output_length: int = 256
    openrouter_api_key: str = ""
    openrouter_model: str = "openrouter/hunter-alpha"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    provider_registry_path: str = "providers.yaml"

    @property
    def is_production(self) -> bool:
        return self.api_env.lower() == "production"


settings = Settings()


def validate_runtime_settings() -> None:
    if not settings.is_production:
        return
    if settings.jwt_secret == "change-me-in-production" or len(settings.jwt_secret) < 32:
        raise RuntimeError("JWT secret is too weak for production.")
    if "*" in settings.cors_allow_origins:
        raise RuntimeError("Wildcard CORS is not allowed in production.")
