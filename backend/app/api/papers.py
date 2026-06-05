import hashlib
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_auth
from app.core.config import get_settings
from app.models import Paper, PaperChunk, PaperSection
from app.schemas import (
    PaperIn,
    PaperList,
    PaperOut,
    PaperUpsertResult,
    PdfUploadResult,
)
from app.services.embeddings.client import embed, embeddings_enabled
from app.services.pdf.pipeline import process_pdf

router = APIRouter(prefix="/papers", tags=["papers"], dependencies=[Depends(require_auth)])

@router.post("", response_model=list[PaperUpsertResult])
def upsert_papers(papers_in: list[PaperIn], db: Session = Depends(get_db)) -> list[PaperUpsertResult]:
    results: list[PaperUpsertResult] = []
    for p in papers_in:
        existing = None
        if p.scholar_inbox_id:
            existing = db.scalar(
                select(Paper).where(
                    Paper.scholar_inbox_id == p.scholar_inbox_id, Paper.deleted_at.is_(None)
                )
            )
        if existing:
            existing.title = p.title
            existing.authors = [a.model_dump() for a in p.authors]
            existing.publication_year = p.publication_year
            existing.paper_url = p.paper_url
            existing.pdf_url = p.pdf_url
            existing.tags = p.tags
            existing.source_metadata = {**existing.source_metadata, **p.source_metadata}
            db.commit()
            results.append(PaperUpsertResult(paper_id=existing.id, status=existing.status, created=False))
        else:
            paper = Paper(
                scholar_inbox_id=p.scholar_inbox_id,
                title=p.title,
                authors=[a.model_dump() for a in p.authors],
                publication_year=p.publication_year,
                paper_url=p.paper_url,
                pdf_url=p.pdf_url,
                tags=p.tags,
                source_metadata=p.source_metadata,
                status="discovered",
            )
            db.add(paper)
            db.commit()
            results.append(PaperUpsertResult(paper_id=paper.id, status=paper.status, created=True))
    return results

@router.post("/{paper_id}/pdf", response_model=PdfUploadResult)
def upload_pdf(
    paper_id: uuid.UUID, file: UploadFile = File(...), db: Session = Depends(get_db)
) -> PdfUploadResult:
    settings = get_settings()
    paper = db.get(Paper, paper_id)
    if paper is None or paper.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found.")

    content = file.file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file.")
    if len(content) > settings.max_pdf_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "PDF exceeds size limit.")
    if (file.content_type or "").lower() not in ("application/pdf", "application/octet-stream") \
            and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Expected a PDF.")

    sha256 = hashlib.sha256(content).hexdigest()

    settings.pdf_storage_dir.mkdir(parents=True, exist_ok=True)
    storage_path = settings.pdf_storage_dir / f"{sha256}.pdf"
    if not storage_path.exists():
        storage_path.write_bytes(content)

    from sqlalchemy import text as _text
    db.execute(
        _text("UPDATE papers SET pdf_sha256 = NULL WHERE pdf_sha256 = :h AND id != :pid"),
        {"h": sha256, "pid": str(paper.id)},
    )
    db.flush()

    result = process_pdf(content)

    db.query(PaperChunk).filter(PaperChunk.paper_id == paper.id).delete()
    db.query(PaperSection).filter(PaperSection.paper_id == paper.id).delete()
    db.flush()

    ordering_to_id: dict[int, uuid.UUID] = {}
    for sec in result.sections:
        row = PaperSection(
            paper_id=paper.id,
            section_type=sec.section_type,
            heading=sec.heading,
            content=sec.content,
            ordering=sec.ordering,
        )
        db.add(row)
        db.flush()
        ordering_to_id[sec.ordering] = row.id

    vectors = None
    if embeddings_enabled() and result.chunks:
        vectors = embed([c.content for c in result.chunks])

    for i, chunk in enumerate(result.chunks):
        db.add(
            PaperChunk(
                paper_id=paper.id,
                section_id=ordering_to_id.get(chunk.section_ordering),
                chunk_index=chunk.chunk_index,
                content=chunk.content,
                token_count=chunk.token_count,
                embedding=vectors[i] if vectors else None,
            )
        )

    paper.pdf_storage_path = str(storage_path)
    paper.pdf_sha256 = sha256
    paper.status = "parsed"
    paper.source_metadata = {**(paper.source_metadata or {}), "pipeline_signals": result.signals}
    db.commit()

    return PdfUploadResult(paper_id=paper.id, sha256=sha256, status=paper.status, signals=result.signals)

@router.get("", response_model=PaperList)
def list_papers(limit: int = 50, offset: int = 0, db: Session = Depends(get_db)) -> PaperList:
    limit = max(1, min(limit, 200))
    base = select(Paper).where(Paper.deleted_at.is_(None))
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    rows = db.scalars(
        base.order_by(Paper.first_seen_at.desc()).limit(limit).offset(offset)
    ).all()
    return PaperList(
        items=[PaperOut.model_validate(r) for r in rows], total=total, limit=limit, offset=offset
    )

@router.get("/{paper_id}", response_model=PaperOut)
def get_paper(paper_id: uuid.UUID, db: Session = Depends(get_db)) -> PaperOut:
    paper = db.get(Paper, paper_id)
    if paper is None or paper.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found.")
    return PaperOut.model_validate(paper)

@router.delete("/{paper_id}")
def delete_paper(paper_id: uuid.UUID, db: Session = Depends(get_db)) -> dict:
    paper = db.get(Paper, paper_id)
    if paper is None or paper.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found.")
    paper.deleted_at = datetime.now(timezone.utc)
    db.commit()
    return {"deleted": True, "paper_id": str(paper_id)}
