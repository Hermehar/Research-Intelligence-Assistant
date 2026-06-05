from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas import HealthOut
from app.services.llm.client import is_reachable

router = APIRouter(tags=["health"])

@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    settings = get_settings()
    reachable, err = is_reachable()
    return HealthOut(
        status="ok",
        model=settings.llm_model,
        llm_reachable=reachable,
        llm_error=err,
        embeddings_enabled=settings.embeddings_enabled,
    )
