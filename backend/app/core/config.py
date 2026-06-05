from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://researcher:changeme@localhost:5432/research_assistant"

    pdf_storage_dir: Path = Path("./data/pdfs")
    max_pdf_mb: int = 50

    llm_base_url: str = "http://localhost:8001/v1"
    llm_model: str = "Qwen/Qwen2.5-32B-Instruct"
    llm_api_key: str = "not-needed-for-local-vllm"
    llm_timeout_s: int = 120

    embeddings_enabled: bool = False
    embeddings_base_url: str = "http://localhost:8002/v1"
    embeddings_model: str = "BAAI/bge-large-en-v1.5"
    embedding_dim: int = 1024

    require_api_key: bool = False
    api_key: str = ""

    allowed_origins: str = "chrome-extension://*"

    @property
    def max_pdf_bytes(self) -> int:
        return self.max_pdf_mb * 1024 * 1024

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

@lru_cache
def get_settings() -> Settings:
    return Settings()
