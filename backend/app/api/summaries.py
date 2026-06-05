import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_auth
from app.models import Summary
from app.schemas import SummaryOut

router = APIRouter(prefix="/summaries", tags=["summaries"], dependencies=[Depends(require_auth)])

@router.get("/{paper_id}", response_model=list[SummaryOut])
def get_summaries(paper_id: uuid.UUID, db: Session = Depends(get_db)) -> list[SummaryOut]:
    rows = db.scalars(
        select(Summary).where(Summary.paper_id == paper_id).order_by(Summary.generated_at.desc())
    ).all()
    return [SummaryOut.model_validate(r) for r in rows]
