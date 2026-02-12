from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_env: str = "development"
    cors_allow_origins: str = "http://localhost:3000"
    max_upload_mb: int = 25
    database_url: str = "sqlite:///./manga_translate.db"
    redis_url: str = "redis://localhost:6379/0"
    pipeline_queue_name: str = "pipeline:jobs"
    pipeline_job_timeout_sec: int = 120
    pipeline_retry_count: int = 2
    pipeline_circuit_failure_threshold: int = 5
    pipeline_circuit_reset_sec: int = 60
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    s3_endpoint: str = "http://localhost:9000"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_bucket: str = "manga-pages"
    s3_region: str = "us-east-1"
    signed_url_expires_sec: int = 900
    rate_limit_per_minute: int = 60


settings = Settings()
