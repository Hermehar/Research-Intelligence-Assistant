# Setup — Phase 1 backend

This brings up the backend (PDF pipeline + structured summarization) on your
machine. Localhost-only: no HTTPS or API key is required yet. Enable both
before exposing the backend on any network (see `security-model.md`).

## Option A — Docker (recommended)

```bash
cp backend/.env.example backend/.env      # edit if you like; defaults work locally
cd deploy
docker compose up --build                  # starts Postgres+pgvector and the backend
```

Backend: http://127.0.0.1:8000  ·  Interactive API docs: http://127.0.0.1:8000/docs

## Option B — Local Python

```bash
# 1. Postgres with pgvector (Docker is easiest for just the DB)
docker run -d --name ra-db -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=researcher -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=research_assistant pgvector/pgvector:pg16

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

## The LLM (when you're ready)

The backend talks to any OpenAI-compatible endpoint, so you can develop before
the A100 is set up. When ready, run vLLM and point `.env` at it:

```bash
# On the A100 box. Pick the model that fits your card's memory:
#   40 GB  -> Qwen/Qwen2.5-32B-Instruct
#   80 GB  -> a 72B AWQ build
python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen2.5-32B-Instruct --port 8001
```

Then set in `.env`: `LLM_BASE_URL=http://<a100-host>:8001/v1` and `LLM_MODEL=...`.
This is the only change needed — "not sure about memory yet" doesn't block the
rest of the backend; summarization simply waits until an endpoint is reachable.

## Verify the acceptance criteria

```bash
BASE=http://127.0.0.1:8000/api/v1

# Health — reports the configured model and whether the LLM is reachable
curl -s $BASE/health | python -m json.tool

# 1) Register a paper -> get its id
PID=$(curl -s -X POST $BASE/papers -H 'Content-Type: application/json' \
  -d '[{"title":"Attention Is All You Need","paper_url":"https://arxiv.org/abs/1706.03762"}]' \
  | python -c "import sys,json; print(json.load(sys.stdin)[0]['paper_id'])")

# 2) Upload its PDF -> pipeline runs, returns quality signals
curl -s -X POST $BASE/papers/$PID/pdf -F "file=@paper.pdf" | python -m json.tool

# 3) Summarize -> returns a run_id (202)
RID=$(curl -s -X POST $BASE/analyze/summarize -H 'Content-Type: application/json' \
  -d "{\"paper_ids\":[\"$PID\"]}" | python -c "import sys,json; print(json.load(sys.stdin)['run_id'])")

# 4) Poll the run -> structured summary with confidence + provenance once done
curl -s $BASE/runs/$RID | python -m json.tool
```

Phase 1 acceptance: step 4 returns the nine summary fields, a `confidence_score`
with its `confidence_factors`, the source/PDF links, and the model + prompt
version that produced it.

## Run the tests

```bash
cd backend && pip install -e ".[dev]" && pytest
```

The pipeline and summarizer tests need no database or LLM. Full HTTP
integration tests require a running Postgres.
