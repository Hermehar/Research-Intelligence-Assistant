from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_auth
from app.models import AnalysisRun, Paper
from app.schemas import RunAccepted, SummarizeRequest
from app.tasks.summarize import run_summarize

router = APIRouter(prefix="/analyze", tags=["analyze"], dependencies=[Depends(require_auth)])

@router.post("/summarize", response_model=RunAccepted, status_code=status.HTTP_202_ACCEPTED)
def summarize(
    req: SummarizeRequest, background: BackgroundTasks, db: Session = Depends(get_db)
) -> RunAccepted:
    if not req.paper_ids:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No paper_ids provided.")

    for pid in req.paper_ids:
        paper = db.get(Paper, pid)
        if paper is None or paper.deleted_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Paper {pid} not found.")
        if paper.status not in ("parsed", "summarized"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Paper {pid} has no parsed PDF yet (status={paper.status}). Upload a PDF first.",
            )

    run = AnalysisRun(
        run_type="summarize",
        status="queued",
        params={"paper_ids": [str(p) for p in req.paper_ids], "mode": req.mode},
    )
    db.add(run)
    db.commit()

    background.add_task(run_summarize, run.id, req.paper_ids)
    return RunAccepted(run_id=run.id, status=run.status)
