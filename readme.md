# Research Intelligence Assistant

[![License](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](LICENSE)

A self-hosted AI research assistant that connects [Scholar Inbox](https://scholar-inbox.com) to a local LLM running on your own GPU. It fetches papers across any date range, downloads and parses their PDFs, generates structured nine-field summaries with confidence scores, stores everything in a local knowledge base, and lets you compare papers side by side — with no external API calls and no paper data leaving your machine.

---

## How it works

```
Scholar Inbox (browser)
        │
        │  Content script reads paper cards + downloads PDFs
        │  using your existing authenticated session
        ▼
Chrome Extension (Service Worker)
        │
        │  HTTPS  ·  API key
        ▼
FastAPI Backend  ──►  PDF pipeline: extract → section detection → chunking
  (A100 server)  ──►  Qwen 2.5 via vLLM: parallel summarisation
                 ──►  PostgreSQL + pgvector: persist papers, summaries, embeddings
```

The extension is the only component that touches Scholar Inbox. The backend never sees your credentials. The browser never sees your model weights.

---

## Features

| | Feature | Phase |
|---|---|---|
| ✅ | Fetch papers from Scholar Inbox across any date range | 2 |
| ✅ | Automatic multi-day date navigation | 2 |
| ✅ | PDF download via your authenticated browser session | 2 |
| ✅ | Section-aware PDF parsing (Abstract → Conclusion) | 1 |
| ✅ | Nine-field structured summaries with signal-derived confidence score | 1 |
| ✅ | Parallel multi-paper analysis | 2 |
| ✅ | Side-by-side paper comparison | 2 |
| ✅ | Keyword search across stored summaries | 2 |
| ✅ | Persistent knowledge base with delete controls | 2 |
| 🔲 | Semantic vector search (pgvector) | 3 |
| 🔲 | Autonomous monitoring + weekly digest | 3 |

---

## Requirements

### GPU server

| | Minimum | Recommended |
|---|---|---|
| GPU | 16 GB VRAM | NVIDIA A100 40 GB |
| CUDA driver | 12.1 | 12.6 |
| Python | 3.11 | 3.12 |
| RAM | 32 GB | 64 GB |
| Disk | 50 GB free | 100 GB free |

### Local machine

- Google Chrome 114+
- SSH access to the GPU server

---

## Server setup

### 1. Clone and create the environment

```bash
git clone https://github.com/YOUR_USERNAME/research-assistant.git
cd research-assistant

conda create -n research-assistant python=3.12 -y
conda activate research-assistant
```

### 2. Install the backend

```bash
cd backend
pip install -e ".[dev]"
cp .env.example .env
```

Open `.env` and set `DATABASE_URL` to point at your Postgres instance (see step 3).

### 3. Set up Postgres

The cleanest no-root approach on a shared server is conda's bundled Postgres:

```bash
conda install -y -c conda-forge postgresql pgvector
```

Initialize a personal cluster on port 5433 (avoids conflicts with any system Postgres on 5432):

```bash
initdb -D ~/pgdata
mkdir -p ~/pgdata/run

pg_ctl -D ~/pgdata \
  -l ~/pgdata/postgres.log \
  -o "-p 5433 -c listen_addresses=127.0.0.1 -k $HOME/pgdata/run" \
  start

createdb -h 127.0.0.1 -p 5433 research_assistant
psql -h 127.0.0.1 -p 5433 -d research_assistant \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Update `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgresql+psycopg://YOUR_USERNAME@127.0.0.1:5433/research_assistant
```

### 4. Start the model

```bash
pip install vllm==0.6.6 "transformers==4.46.3"

CUDA_VISIBLE_DEVICES=0 vllm serve Qwen/Qwen2.5-7B-Instruct \
    --port 8001 \
    --gpu-memory-utilization 0.75 \
    --max-model-len 8192 \
    --guided-decoding-backend lm-format-enforcer \
    --enforce-eager
```

The first run downloads model weights (~15 GB). Subsequent starts take ~30 seconds from cache.

**Model sizing:**

| GPU VRAM | Model |
|---|---|
| 16 GB | `Qwen/Qwen2.5-7B-Instruct` |
| 24 GB | `Qwen/Qwen2.5-14B-Instruct` |
| 40 GB | `Qwen/Qwen2.5-32B-Instruct` |
| 80 GB | `Qwen/Qwen2.5-72B-Instruct-AWQ` |

### 5. Start the backend

```bash
cd research-assistant/backend
conda activate research-assistant
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Verify everything is running:

```bash
curl -s http://127.0.0.1:8080/api/v1/health | python3 -m json.tool
```

```json
{
    "status": "ok",
    "model": "Qwen/Qwen2.5-7B-Instruct",
    "llm_reachable": true,
    "embeddings_enabled": false
}
```

### 6. One-command startup script

After the first-time setup above, save this so future sessions are a single command:

```bash
mkdir -p ~/ra-logs

cat > ~/start-research-assistant.sh << 'EOF'
#!/bin/bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate research-assistant

pg_ctl -D ~/pgdata -l ~/ra-logs/postgres.log \
  -o "-p 5433 -c listen_addresses=127.0.0.1 -k $HOME/pgdata/run" start
sleep 3

cd ~/research-assistant/backend
nohup uvicorn app.main:app --host 0.0.0.0 --port 8080 \
  > ~/ra-logs/backend.log 2>&1 &

nohup env CUDA_VISIBLE_DEVICES=0 vllm serve Qwen/Qwen2.5-7B-Instruct \
    --port 8001 --gpu-memory-utilization 0.75 --max-model-len 8192 \
    --guided-decoding-backend lm-format-enforcer --enforce-eager \
  > ~/ra-logs/vllm.log 2>&1 &

echo "Waiting for vLLM to load model weights (~45s)..."
sleep 45
curl -s http://127.0.0.1:8080/api/v1/health | python3 -m json.tool
EOF

chmod +x ~/start-research-assistant.sh
```

```bash
~/start-research-assistant.sh
```

---

## Extension setup

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the `extension/` folder
4. The **⬡** icon appears in your toolbar

### Connect to the backend

Click **⬡** → **⚙ Settings** → set **Backend URL** → **Test connection** → **Save**

---

## Connecting browser to server

### Same local network

Use the server's LAN IP directly in the Settings tab:

```
http://192.168.x.x:8080
```

Find it with:

```bash
hostname -I | awk '{print $1}'
```

### Remote server via SSH tunnel

Run this on your local machine and keep it open:

```bash
ssh -N -L 8080:127.0.0.1:8080 YOUR_USERNAME@YOUR_SERVER_IP
```

Then set Backend URL to `http://127.0.0.1:8080`.

Auto-reconnecting version:

```bash
while true; do
  ssh -N -L 8080:127.0.0.1:8080 -o ServerAliveInterval=30 YOUR_USERNAME@YOUR_SERVER_IP
  sleep 5
done
```

### One-click desktop launcher (Mac)

Set up passwordless SSH first (one time):

```bash
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/id_rsa
ssh-copy-id YOUR_USERNAME@YOUR_SERVER_IP
```

Create a desktop shortcut that starts everything and opens Scholar Inbox:

```bash
cat > ~/Desktop/ResearchAssistant.command << 'EOF'
#!/bin/bash
ssh -o StrictHostKeyChecking=no YOUR_USERNAME@YOUR_SERVER_IP \
  "bash ~/start-research-assistant.sh" &
sleep 3
open -a "Google Chrome" "https://www.scholar-inbox.com"
wait
EOF
chmod +x ~/Desktop/ResearchAssistant.command
```

Double-click to start.

---

## Usage

### Fetch papers

1. Open [scholar-inbox.com](https://scholar-inbox.com) and log in
2. Click **⬡** to open the side panel
3. Choose a time range: Today, 3 days, 1 week, 2 weeks, 1 month, or a custom date range
4. Click **Fetch** — the extension navigates Scholar Inbox's date selector automatically

### Analyze

1. Check the papers you want (or click **All**)
2. Click **Analyze**
3. The extension downloads each PDF through your browser session, uploads it to the backend, and runs parallel summarization — all selected papers are processed at the same time
4. The **Summaries** tab opens automatically when done

### Summaries

Each card shows a confidence score derived from three signals — PDF parse quality, how many expected sections were found, and how many of the nine fields the model could fill from the actual text. Click any card to expand all nine fields plus source links, model name, and prompt version.

### Compare

**Compare** tab → check 2–5 papers → **Compare** → side-by-side table across all nine dimensions.

### Knowledge base search

**KB** tab → type a keyword → **Search** → matching fields are surfaced across all stored summaries.

---

## Configuration reference

`backend/.env` (copy from `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://...` | Postgres connection string |
| `LLM_BASE_URL` | `http://127.0.0.1:8001/v1` | vLLM endpoint |
| `LLM_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | Model name |
| `LLM_TIMEOUT_S` | `120` | Seconds before an LLM call times out |
| `MAX_PDF_MB` | `50` | PDF upload size cap |
| `EMBEDDINGS_ENABLED` | `false` | pgvector semantic search (Phase 3) |
| `REQUIRE_API_KEY` | `false` | Enforce Bearer token auth |
| `API_KEY` | _(empty)_ | Secret key for the extension to send |

> Set `REQUIRE_API_KEY=true` and a strong `API_KEY` before making the backend reachable on any network beyond localhost.

---

## API

Base URL: `http://YOUR_SERVER:8080/api/v1`

Interactive docs: `http://YOUR_SERVER:8080/docs`

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Backend and LLM status |
| POST | `/papers` | Register paper metadata (batch upsert by arXiv ID) |
| POST | `/papers/{id}/pdf` | Upload and parse a PDF |
| GET | `/papers` | List all stored papers |
| DELETE | `/papers/{id}` | Remove a paper and its summaries |
| POST | `/analyze/summarize` | Start parallel summarization run |
| GET | `/runs/{id}` | Poll job status and results |
| GET | `/summaries/{paper_id}` | Summaries for a specific paper |

---

## Tests

```bash
cd backend
pytest
```

The test suite covers the PDF pipeline and summarizer helpers. No database or GPU required.

---

## Project layout

```
research-assistant/
├── backend/
│   ├── app/
│   │   ├── api/            REST endpoints
│   │   ├── core/           Config, auth
│   │   ├── db/             SQLAlchemy models and session
│   │   ├── models/         ORM models
│   │   ├── schemas/        Pydantic schemas
│   │   ├── services/
│   │   │   ├── pdf/        Extraction, section detection, chunking
│   │   │   ├── llm/        vLLM client, prompts, summarizer
│   │   │   └── embeddings/ pgvector (Phase 3)
│   │   └── tasks/          Background analysis jobs
│   ├── tests/
│   └── pyproject.toml
├── extension/
│   ├── manifest.json
│   ├── background/         Service worker
│   ├── content/            Content script
│   └── sidepanel/          UI
├── deploy/                 Docker Compose and Dockerfile
└── docs/                   Architecture and setup guides
```

---

## Design

- **User always in control.** Nothing runs without an explicit trigger. The AI surfaces analysis; you make every decision.
- **No credentials in scope.** The extension operates on your existing Scholar Inbox session. It never reads, stores, or transmits passwords.
- **Full provenance on every output.** Every summary carries the source paper link, PDF link, model name, prompt version, and a signal-derived confidence score.
- **Self-hosted and deletable.** All data lives on your hardware. One click removes any paper or summary.
- **Local AI only.** No paper content leaves your server.

---

## License

MIT — see [LICENSE](LICENSE).
