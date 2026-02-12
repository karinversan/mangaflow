from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_env: str = "development"
    cors_allow_origins: str = "http://localhost:3000"
    max_upload_mb: int = 25
    database_url: str = "sqlite:///./manga_translate.db"


settings = Settings()
