# Research Intelligence Assistant — Architecture & Design

**Status:** Draft for review (Phase 0). No implementation until you approve this document.
**Scope:** Single-user, self-hosted research assistant. Browser extension (frontend) + A100-backed AI server (backend).
**Design stance:** Assistant, not agent. The system surfaces analysis; you make every decision.

---

## 0. Design principles (how every later decision is judged)

These are the tie-breakers. When two designs are otherwise equal, the one that better satisfies these wins.

1. **The user is the operator, not the supervised.** Nothing runs without an explicit trigger except the one mode you deliberately switch on (autonomous monitoring), which is off by default and reversible.
2. **Credentials are never in scope.** The extension acts on your existing authenticated browser session. It never reads, stores, requests, or transmits passwords, cookies (beyond what the browser attaches automatically to your own requests), or email.
3. **Every AI output is traceable.** Each summary, ranking, and claim carries its source paper, its PDF, the model + prompt version that produced it, and a confidence score. No "trust me" outputs.
4. **Self-hostable and deletable.** All data lives on hardware you control. A single action wipes any paper, any analysis, or everything.
5. **Local-first AI.** No paper content leaves your server. The LLM and embeddings run on the A100; no third-party API is required for analysis.

A note on principle 3: "confidence score" is presented honestly. An LLM's self-reported confidence is *not* calibrated probability — it's a heuristic. We will label it as such in the UI and derive it from concrete signals (PDF parse quality, section coverage, whether key fields were found) rather than asking the model "how confident are you?" in a vacuum. Overstating certainty would violate the transparency principle it's meant to serve.

---

## 1. System architecture (component responsibilities)

Three trust zones, as in the diagram: **Browser**, **A100 backend**, **Storage**. The extension is the only component that touches Scholar Inbox; the backend is the only component that runs AI; storage is reachable only from the backend.

### Browser (Chrome MV3 extension)
| Component | Responsibility | Explicitly does NOT |
|---|---|---|
| Content script | Parse the *Relevant Papers* DOM, extract paper cards + metadata, fetch PDFs using the active session | Log in, read credentials, run AI |
| Side panel (React) | All UI: trigger analysis, show summaries/comparisons/trends/gaps/KB | Store paper content long-term (backend owns the KB) |
| Service worker (background) | Message routing, calls to backend, `chrome.alarms` for optional monitoring | Persist sensitive data; run on non-Scholar-Inbox pages |

### A100 backend (FastAPI)
| Service | Responsibility |
|---|---|
| API gateway | Auth (Bearer API key), rate limiting, request validation, routing |
| PDF pipeline | Text extraction, section detection, chunking |
| LLM service | Qwen served via vLLM (OpenAI-compatible endpoint) for summarization/comparison/synthesis |
| Embedding service | Sentence/chunk embeddings for semantic search and clustering |
| Analysis services | Summary, comparison, landscape, gap discovery, reading-order ranking |
| Task runner | Async execution of long jobs + scheduled monitoring digest |

### Storage
| Store | Holds |
|---|---|
| PostgreSQL + `pgvector` | Paper metadata, sections, chunks, **embeddings**, summaries, comparisons, reports, settings, audit log |
| File store (disk) | Validated PDFs, deduplicated by SHA-256 |

**Why `pgvector` instead of a separate vector DB:** your spec marks the vector DB optional. For a single user, a dedicated vector store (Qdrant/Weaviate/Milvus) is operational overhead with no payoff at this scale. `pgvector` keeps embeddings transactionally consistent with their papers in one database, one backup, one container. If the KB ever grows past ~hundreds of thousands of chunks and recall latency degrades, swapping to a dedicated store is a localized change behind the retrieval interface — so this is reversible, not a lock-in.

### End-to-end data flow (manual mode, the default)
```
Scholar Inbox page
  → content script extracts cards + fetches PDFs (your session)
  → side panel: you select papers, click "Summarize"
  → service worker POSTs papers + PDFs to backend (HTTPS + API key)
  → PDF pipeline: extract → detect sections → chunk
  → embedding service: embed chunks → store in pgvector
  → LLM service: structured summary per paper
  → results persisted + returned
  → side panel renders summary with source/PDF links + confidence
```

---

## 2. Database schema (PostgreSQL + pgvector)

Conventions: `uuid` primary keys (`gen_random_uuid()`), `timestamptz` everywhere, soft-delete via `deleted_at` so the "delete my data" control is auditable and reversible until purged. Embedding dimension below assumes a 1024-dim model (e.g. `bge-large-en-v1.5`); adjust to your chosen model.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Papers discovered from Scholar Inbox
CREATE TABLE papers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scholar_inbox_id TEXT,                       -- stable id from the page, if present
    title            TEXT NOT NULL,
    authors          JSONB DEFAULT '[]'::jsonb,  -- [{name, affiliation?}]
    publication_year INT,
    paper_url        TEXT,
    pdf_url          TEXT,
    tags             TEXT[] DEFAULT '{}',
    source_metadata  JSONB DEFAULT '{}'::jsonb,  -- anything else scraped from the card
    pdf_storage_path TEXT,                        -- relative path in file store
    pdf_sha256       TEXT,                        -- dedupe + integrity
    status           TEXT NOT NULL DEFAULT 'discovered',
                     -- discovered|pdf_fetched|parsed|summarized|failed
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    UNIQUE (pdf_sha256)
);

-- Detected sections (Abstract, Introduction, Methodology, ...)
CREATE TABLE paper_sections (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id     UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    section_type TEXT NOT NULL,   -- abstract|introduction|related_work|method|experiments|results|conclusion|other
    heading      TEXT,
    content      TEXT,
    ordering     INT NOT NULL
);

-- Chunks + embeddings for retrieval and clustering
CREATE TABLE paper_chunks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id    UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    section_id  UUID REFERENCES paper_sections(id) ON DELETE SET NULL,
    chunk_index INT NOT NULL,
    content     TEXT NOT NULL,
    token_count INT,
    embedding   VECTOR(1024),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chunks_embedding ON paper_chunks
    USING hnsw (embedding vector_cosine_ops);

-- Structured summary (matches your JSON schema 1:1, plus provenance)
CREATE TABLE summaries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id            UUID NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    model               TEXT NOT NULL,        -- e.g. qwen2.5-32b-instruct
    prompt_version      TEXT NOT NULL,        -- provenance for transparency
    research_problem    TEXT,
    motivation          TEXT,
    methodology         TEXT,
    dataset             TEXT,
    evaluation_metrics  TEXT,
    key_results         TEXT,
    novel_contributions TEXT,
    limitations         TEXT,
    future_work         TEXT,
    confidence_score    NUMERIC(3,2),         -- 0.00–1.00, signal-derived (see §0)
    confidence_factors  JSONB,                -- {parse_quality, section_coverage, fields_found}
    raw_json            JSONB,                -- full model output, for audit
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Comparisons across N papers
CREATE TABLE comparisons (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT,
    config       JSONB,         -- columns chosen, mode
    result_table JSONB,         -- rows keyed by paper_id
    narrative    TEXT,
    model        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE comparison_papers (
    comparison_id UUID REFERENCES comparisons(id) ON DELETE CASCADE,
    paper_id      UUID REFERENCES papers(id) ON DELETE CASCADE,
    PRIMARY KEY (comparison_id, paper_id)
);

-- Topics for tagging / landscape
CREATE TABLE topics (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT UNIQUE NOT NULL,
    description TEXT,
    embedding   VECTOR(1024)
);
CREATE TABLE paper_topics (
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    topic_id UUID REFERENCES topics(id) ON DELETE CASCADE,
    weight   NUMERIC(4,3),
    PRIMARY KEY (paper_id, topic_id)
);

-- Landscape / gap / reading-order reports (one table, typed)
CREATE TABLE reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_type  TEXT NOT NULL,   -- landscape|gaps|reading_order
    scope        JSONB,           -- which papers / filters
    payload      JSONB NOT NULL,  -- themes, trends, gaps, ranked list w/ justifications
    narrative    TEXT,
    model        TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Async job + monitoring audit trail (transparency)
CREATE TABLE analysis_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type    TEXT NOT NULL,   -- summarize|compare|landscape|gaps|ranking|monitor
    status      TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
    params      JSONB,
    error       TEXT,
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Weekly digests (autonomous mode output)
CREATE TABLE digests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    period_start TIMESTAMPTZ,
    period_end   TIMESTAMPTZ,
    payload      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-user settings (autonomous mode toggle, schedule, prefs)
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backend auth: hashed API keys (never stored in plaintext)
CREATE TABLE api_keys (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label      TEXT,
    key_hash   TEXT NOT NULL,   -- argon2/bcrypt of the key
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
```

Entity relationships in brief: a `papers` row owns its `paper_sections`, `paper_chunks`, and `summaries` (cascade delete). `comparisons` and `reports` reference papers by join/scope and survive independently. `analysis_runs` is the audit spine that every long operation writes to, which is what makes the "what did the AI do and when" view possible.

---

## 3. Folder structure

```
research-assistant/
├── extension/                      # Chrome MV3 + React + TypeScript
│   ├── manifest.json
│   ├── src/
│   │   ├── content/                # Scholar Inbox DOM extraction
│   │   │   ├── extractor.ts        # parse Relevant Papers cards
│   │   │   ├── selectors.ts        # ALL DOM selectors isolated here (see §10)
│   │   │   └── pdf-collector.ts
│   │   ├── background/             # service worker
│   │   │   ├── index.ts
│   │   │   ├── api-client.ts       # talks to backend
│   │   │   └── monitor.ts          # chrome.alarms scheduler
│   │   ├── sidepanel/              # React UI
│   │   │   ├── App.tsx
│   │   │   ├── tabs/               # NewPapers, Summaries, Comparisons, Trends, Gaps, KB
│   │   │   ├── components/
│   │   │   └── hooks/
│   │   ├── shared/                 # types, messaging contract, config
│   │   └── lib/
│   ├── tests/
│   └── vite.config.ts
│
├── backend/                        # FastAPI + Python
│   ├── app/
│   │   ├── main.py
│   │   ├── api/                    # routers, one per resource (§4)
│   │   ├── core/                   # config, security, rate limit, logging
│   │   ├── services/
│   │   │   ├── pdf/                # extraction, section detection, chunking
│   │   │   ├── llm/                # vLLM client, prompt templates (versioned)
│   │   │   ├── embeddings/
│   │   │   └── analysis/           # summary, compare, landscape, gaps, ranking
│   │   ├── models/                 # SQLAlchemy models
│   │   ├── schemas/                # Pydantic request/response
│   │   ├── db/                     # session, migrations (alembic)
│   │   └── tasks/                  # async runner + monitor job
│   ├── tests/
│   ├── alembic/
│   └── pyproject.toml
│
├── deploy/
│   ├── docker-compose.yml          # backend, postgres+pgvector, vllm, reverse proxy
│   ├── Dockerfile.backend
│   ├── vllm.service.md
│   └── caddy/Caddyfile             # HTTPS termination
│
├── docs/
│   ├── architecture-design.md      # this file
│   ├── api-spec.md
│   ├── security-model.md
│   └── setup.md
└── README.md
```

---

## 4. API specification (REST)

Base: `https://<your-server>/api/v1`. Auth: `Authorization: Bearer <api-key>` on every request. All bodies JSON except PDF upload (multipart). Long operations return `202 Accepted` with a `run_id`; poll the run or receive results once `status=done`.

| Method | Path | Purpose | Returns |
|---|---|---|---|
| GET | `/health` | Liveness + model/GPU status | `{status, model, gpu}` |
| POST | `/papers` | Upsert extracted paper metadata (batch) | `[{paper_id, status}]` |
| POST | `/papers/{id}/pdf` | Upload a PDF (multipart) | `{paper_id, sha256, status}` |
| GET | `/papers` | List/filter KB papers | paginated papers |
| GET | `/papers/{id}` | Paper + sections + latest summary | paper detail |
| DELETE | `/papers/{id}` | Soft-delete a paper and its analyses | `{deleted}` |
| POST | `/analyze/summarize` | Summarize selected paper_ids | `202 {run_id}` |
| POST | `/analyze/compare` | Compare 2–N papers | `202 {run_id}` |
| POST | `/analyze/landscape` | Landscape across scope | `202 {run_id}` |
| POST | `/analyze/gaps` | Gap discovery across scope | `202 {run_id}` |
| POST | `/analyze/reading-order` | Ranked reading list + justifications | `202 {run_id}` |
| GET | `/runs/{run_id}` | Job status + result when done | run + payload |
| GET | `/summaries/{paper_id}` | Latest/all summaries for a paper | summaries |
| GET | `/comparisons/{id}` | A stored comparison | comparison |
| GET | `/reports/{id}` | A landscape/gap/reading-order report | report |
| POST | `/kb/search` | Semantic + filtered KB search | ranked chunks/papers |
| GET | `/digests` | List monitoring digests | digests |
| GET/PUT | `/settings` | Read/update settings (e.g. monitoring on/off) | settings |

Example — summarize request/response:
```jsonc
// POST /analyze/summarize
{ "paper_ids": ["…","…"], "mode": "detailed" }
// 202
{ "run_id": "…", "status": "queued" }

// GET /runs/{run_id}  (once done)
{
  "run_id": "…", "run_type": "summarize", "status": "done",
  "results": [{
    "paper_id": "…",
    "summary": { "research_problem": "…", "methodology": "…", "...": "..." },
    "confidence_score": 0.78,
    "confidence_factors": { "parse_quality": 0.9, "section_coverage": 0.83 },
    "source_link": "https://…", "pdf_link": "https://…",
    "model": "qwen2.5-32b-instruct", "prompt_version": "summary.v1"
  }]
}
```

Full request/response schemas for every endpoint go in `docs/api-spec.md`, generated from the Pydantic models so the docs can't drift from the code (FastAPI's `/docs` OpenAPI is the live source).

---

## 5. Security model

**Threat model is deliberately narrow:** one user, one server you control, one browser you control. The realistic risks are (a) the backend being exposed to the internet without auth, (b) a malicious or buggy page tricking the extension into doing too much, (c) PDFs as a malicious-file vector, and (d) secrets leaking into the repo. The design addresses each:

- **Extension ↔ backend auth.** A long-lived API key generated on the server, pasted once into extension settings, sent as a Bearer token over HTTPS. Stored hashed server-side (`api_keys.key_hash`); revocable. For a single user this is the right weight — OAuth would be ceremony with no second party. If you want a second factor, the reverse proxy can enforce mTLS with a client cert; noted as optional.
- **Transport.** HTTPS only, terminated by a reverse proxy (Caddy with automatic certs, or your own cert). No plaintext HTTP listener. HSTS on.
- **Least privilege in the manifest.** `host_permissions` limited to the Scholar Inbox origin and your backend origin — nothing else. No `<all_urls>`, no `tabs` beyond what the side panel needs, no `cookies` permission (the browser attaches your session to first-party fetches automatically; the extension never reads cookie values).
- **No credential surface.** Reaffirmed structurally: there is no code path that reads form fields, no permission to do so, and no endpoint that accepts a password. This is enforced by absence, not by policy text.
- **PDF handling.** Enforce content-type and a size cap on upload, store outside the web root, never execute, hash with SHA-256 (dedupe + integrity), parse in the backend process with a hardened library, and never reflect a user-supplied filename into a filesystem path (UUID-named storage prevents path traversal).
- **Rate limiting.** Per-key limits (`slowapi`/middleware) to protect the GPU from runaway loops, especially relevant once monitoring is enabled.
- **Secrets.** `.env` for keys/DB creds, git-ignored; an `.env.example` documents the shape. No secrets in the image layers or the repo.
- **Data control.** `DELETE /papers/{id}` and a "wipe everything" settings action satisfy the deletion principle; soft-delete then scheduled purge so an accidental click is recoverable briefly.
- **Server hardening (ops, in setup.md).** Backend bound to localhost behind the proxy; firewall to expose only 443; SSH keys only; the vLLM port never exposed publicly.

A **security review checkpoint** is a gate before any internet-facing deployment — listed as a roadmap milestone, not an afterthought.

---

## 6. Extension architecture (MV3 specifics)

- **Content script** runs only on the Scholar Inbox origin (manifest match). It reads the *Relevant Papers* DOM via selectors isolated in one `selectors.ts` module (so the inevitable DOM changes are a one-file fix), extracts `{title, authors, year, paper_url, pdf_url, tags, metadata}` per card, and supports *selected* vs *all visible* papers. PDFs are fetched here because they may sit behind your session — the content/background context has your cookies, the backend does not.
- **Side panel** (`chrome.sidePanel`) is the React app with your six tabs: New Papers, Summaries, Comparisons, Research Trends, Research Gaps, Knowledge Base. It holds no long-term state; the backend KB is the source of truth, the panel caches in memory for the session.
- **Service worker** is the broker: it receives messages from content script and side panel, calls the backend via `api-client.ts`, and — only when you enable it — runs a `chrome.alarms` timer that checks for new papers and posts them for background analysis, writing results to the KB and assembling the weekly digest.
- **Messaging contract** lives in `shared/` as typed messages so content/background/panel can't drift.

MV3 reality checks baked in: the service worker is ephemeral (it sleeps), so monitoring uses `chrome.alarms` rather than a long-lived timer, and any in-flight job state lives server-side keyed by `run_id`, not in worker memory.

---

## 7. Backend architecture

- **LLM serving:** Qwen via **vLLM**, exposed as an OpenAI-compatible endpoint the `llm` service calls. vLLM is the right pick over Ollama here because paper analysis is throughput- and long-context-heavy (batched chunks, comparison over many papers), which is exactly vLLM's strength; Ollama is simpler but leaves A100 throughput on the table. Model sizing depends on your A100's memory — a 40GB card runs `Qwen2.5-32B-Instruct` comfortably; an 80GB card can run a 72B AWQ variant. Long context (papers are long) favors Qwen2.5's extended context.
- **Embeddings:** a dedicated model (`bge-large-en-v1.5` or a Qwen embedding model) for chunk vectors → `pgvector`. Kept separate from the generative model so each is sized independently.
- **PDF pipeline:** PyMuPDF for fast, reliable text + layout extraction; section detection by heading heuristics, with **GROBID** as an optional upgrade for citation/section parsing tuned to scientific PDFs. Chunking is section-aware so retrieval and summaries respect document structure.
- **Async + scheduling:** long jobs run off the request thread and report through `analysis_runs`. For a single user a lightweight async runner (FastAPI background tasks or ARQ+Redis) is sufficient; Celery is available if you later want retries/visibility at scale. The monitor job reuses the same runner.
- **Prompt versioning:** every analysis prompt is versioned (`summary.v1`, …) and the version is stored on each output — this is what makes results reproducible and the confidence/provenance story real.

---

## 8. Development roadmap

Each phase ends with a concrete, demoable acceptance criterion. Phases are sequenced so you have a working end-to-end slice early, then breadth.

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | **This document** + environment setup (Docker, Postgres+pgvector, vLLM serving Qwen) | `GET /health` returns model + GPU status |
| 1 | Backend core: PDF pipeline + single-paper structured summary | Upload one PDF → get the JSON summary with confidence + provenance |
| 2 | Extension skeleton + DOM extraction + manual summarize flow | In Scholar Inbox, select papers → click Summarize → summaries render in the panel |
| 3 | Comparison engine + KB storage + semantic search | Compare 5 papers into a table; search the KB and get relevant chunks |
| 4 | Landscape, gap discovery, reading-order ranking | Generate all three reports across a batch, each with justifications |
| 5 | Autonomous monitoring + weekly digest (opt-in) | Toggle on → new papers analyzed in background → digest appears |
| 6 | Security review + tests + Docker deploy + docs | Review checklist passed; one-command deploy; setup guide reproducible |

---

## 9. Key decisions, restated

- `pgvector` over a standalone vector DB (single-user scale, reversible).
- vLLM over Ollama (throughput + long context on the A100).
- API-key Bearer auth over OAuth (no second party; optional mTLS available).
- Confidence as a **signal-derived, honestly-labeled** score, not the model's raw self-assessment.
- Section-aware PDF parsing (PyMuPDF, optional GROBID) so structure survives into analysis.

---

## 10. Open questions (need your input before / during Phase 0–2)

1. **A100 memory — 40GB or 80GB?** This fixes the Qwen size (32B vs 72B-AWQ) and embedding co-residency. The single biggest config decision.
2. **Scholar Inbox DOM.** The content-script extractor must be written against the *real* markup of the Relevant Papers section. The selector layer is isolated for this reason, but I'll need either a saved copy of that page's HTML or a short description of a paper card's structure to write reliable selectors. This is the one place the design has a genuine unknown.
3. **Monitoring cadence.** Default is weekly digest — confirm, or set a different interval.
4. **vLLM vs Ollama.** I've recommended vLLM; if you'd prefer Ollama's simpler setup for v1 and to switch later, the `llm` service interface makes that swappable — say the word.
5. **Deployment target.** Is the A100 server internet-reachable (needs the full proxy + cert + hardening path) or only reachable over a private network/VPN (simpler)?
