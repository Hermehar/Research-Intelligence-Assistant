import httpx

from app.core.config import get_settings

def embeddings_enabled() -> bool:
    return get_settings().embeddings_enabled

def embed(texts: list[str]) -> list[list[float]] | None:
    settings = get_settings()
    if not settings.embeddings_enabled or not texts:
        return None

    url = settings.embeddings_base_url.rstrip("/") + "/embeddings"
    payload = {"model": settings.embeddings_model, "input": texts}
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}

    resp = httpx.post(url, json=payload, headers=headers, timeout=settings.llm_timeout_s)
    resp.raise_for_status()
    data = resp.json()
    return [item["embedding"] for item in data["data"]]
