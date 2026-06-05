from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import analyze, health, papers, runs, summaries
from app.core.config import get_settings
from app.db.session import init_db

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Research Intelligence Assistant — Backend",
        version="0.1.0",
        description="Phase 1: PDF pipeline + structured single-paper summarization.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=r"chrome-extension://.*",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    api_prefix = "/api/v1"
    app.include_router(health.router, prefix=api_prefix)
    app.include_router(papers.router, prefix=api_prefix)
    app.include_router(analyze.router, prefix=api_prefix)
    app.include_router(runs.router, prefix=api_prefix)
    app.include_router(summaries.router, prefix=api_prefix)
    return app

app = create_app()
