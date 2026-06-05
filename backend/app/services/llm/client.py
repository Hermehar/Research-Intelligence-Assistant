import httpx

from app.core.config import get_settings

class LLMError(RuntimeError):
    pass

def chat(
    messages: list[dict],
    *,
    temperature: float = 0.2,
    max_tokens: int = 1500,
    response_json: bool = False,
) -> str:
    settings = get_settings()
    payload: dict = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_json:
        payload["response_format"] = {"type": "json_object"}

    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    url = settings.llm_base_url.rstrip("/") + "/chat/completions"

    try:
        resp = httpx.post(url, json=payload, headers=headers, timeout=settings.llm_timeout_s)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMError(f"LLM request failed: {exc}") from exc

    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise LLMError(f"Unexpected LLM response shape: {data}") from exc

def is_reachable() -> tuple[bool, str | None]:
    settings = get_settings()
    url = settings.llm_base_url.rstrip("/") + "/models"
    try:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {settings.llm_api_key}"}, timeout=5)
        resp.raise_for_status()
        return True, None
    except httpx.HTTPError as exc:
        return False, str(exc)
