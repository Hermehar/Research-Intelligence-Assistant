import uuid
from datetime import datetime

from pydantic import BaseModel, Field

class AuthorIn(BaseModel):
    name: str
    affiliation: str | None = None

class PaperIn(BaseModel):
    scholar_inbox_id: str | None = None
    title: str
    authors: list[AuthorIn] = Field(default_factory=list)
    publication_year: int | None = None
    paper_url: str | None = None
    pdf_url: str | None = None
    tags: list[str] = Field(default_factory=list)
    source_metadata: dict = Field(default_factory=dict)

class PaperUpsertResult(BaseModel):
    paper_id: uuid.UUID
    status: str
    created: bool

class PaperOut(BaseModel):
    id: uuid.UUID
    title: str
    authors: list
    publication_year: int | None
    paper_url: str | None
    pdf_url: str | None
    tags: list[str]
    status: str
    first_seen_at: datetime

    model_config = {"from_attributes": True}

class PaperList(BaseModel):
    items: list[PaperOut]
    total: int
    limit: int
    offset: int

class PdfUploadResult(BaseModel):
    paper_id: uuid.UUID
    sha256: str
    status: str
    signals: dict

class SummaryOut(BaseModel):
    id: uuid.UUID
    paper_id: uuid.UUID
    model: str
    prompt_version: str
    research_problem: str | None
    motivation: str | None
    methodology: str | None
    dataset: str | None
    evaluation_metrics: str | None
    key_results: str | None
    novel_contributions: str | None
    limitations: str | None
    future_work: str | None
    confidence_score: float | None
    confidence_factors: dict | None
    generated_at: datetime

    model_config = {"from_attributes": True}

class SummarizeRequest(BaseModel):
    paper_ids: list[uuid.UUID]
    mode: str = "detailed"

class RunAccepted(BaseModel):
    run_id: uuid.UUID
    status: str

class RunOut(BaseModel):
    id: uuid.UUID
    run_type: str
    status: str
    params: dict | None
    result: dict | None
    error: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}

class HealthOut(BaseModel):
    status: str
    model: str
    llm_reachable: bool
    llm_error: str | None = None
    embeddings_enabled: bool
