import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_auth
from app.models import AnalysisRun
from app.schemas import RunOut

router = APIRouter(prefix="/runs", tags=["runs"], dependencies=[Depends(require_auth)])

@router.get("/{run_id}", response_model=RunOut)
def get_run(run_id: uuid.UUID, db: Session = Depends(get_db)) -> RunOut:
    run = db.get(AnalysisRun, run_id)
    if run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found.")
    return RunOut.model_validate(run)
