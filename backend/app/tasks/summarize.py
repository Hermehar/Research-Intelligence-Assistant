import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from app.db.session import SessionLocal
from app.models import AnalysisRun, Paper, Summary
from app.services.llm.client import LLMError
from app.services.llm.summarizer import summarize
from app.services.pdf.sections import Section

def _now() -> datetime:
    return datetime.now(timezone.utc)

def _model_name() -> str:
    from app.core.config import get_settings
    return get_settings().llm_model

def _sections_for(paper: Paper) -> list[Section]:
    ordered = sorted(paper.sections, key=lambda s: s.ordering)
    return [Section(s.section_type, s.heading, s.content or "", s.ordering) for s in ordered]

def _summarize_one(pid: uuid.UUID) -> dict:
    db = SessionLocal()
    try:
        paper = db.get(Paper, pid)
        if paper is None or paper.deleted_at is not None:
            return {"paper_id": str(pid), "error": "paper not found in database"}

        sections = _sections_for(paper)
        signals  = paper.source_metadata.get("pipeline_signals", {}) if paper.source_metadata else {}

        if not sections:
            return {
                "paper_id": str(pid),
                "error": "no sections found — PDF may not have been uploaded yet",
            }

        result = summarize(paper.title, sections, signals)

        summary = Summary(
            paper_id=paper.id,
            model=_model_name(),
            prompt_version=result.prompt_version,
            confidence_score=result.confidence_score,
            confidence_factors=result.confidence_factors,
            raw_json=result.raw,
            **result.fields,
        )
        db.add(summary)
        paper.status = "summarized"
        db.commit()

        return {
            "paper_id":          str(paper.id),
            "summary_id":        str(summary.id),
            "confidence_score":  float(result.confidence_score),
            "confidence_factors": result.confidence_factors,
            "source_link":       paper.paper_url,
            "pdf_link":          paper.pdf_url,
            **result.fields,
        }

    except LLMError as exc:
        return {"paper_id": str(pid), "error": f"LLM error: {exc}"}
    except Exception as exc:
        db.rollback()
        return {"paper_id": str(pid), "error": f"Unexpected error: {exc}"}
    finally:
        db.close()

def run_summarize(run_id: uuid.UUID, paper_ids: list[uuid.UUID]) -> None:
    db = SessionLocal()
    try:
        run = db.get(AnalysisRun, run_id)
        if run is None:
            return
        run.status     = "running"
        run.started_at = _now()
        db.commit()
    finally:
        db.close()

    results: list[dict] = []
    try:
        max_workers = min(len(paper_ids), 3)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(_summarize_one, pid): pid for pid in paper_ids}
            for future in as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as exc:
                    pid = futures[future]
                    results.append({"paper_id": str(pid), "error": str(exc)})
    except Exception as exc:
        results = [{"paper_id": str(pid), "error": str(exc)} for pid in paper_ids]

    db = SessionLocal()
    try:
        run = db.get(AnalysisRun, run_id)
        if run is not None:
            run.status      = "done"
            run.finished_at = _now()
            run.result      = {"results": results}
            db.commit()
    finally:
        db.close()
