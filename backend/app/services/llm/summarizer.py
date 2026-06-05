import json
import time
from dataclasses import dataclass

from app.services.llm.client import LLMError, chat
from app.services.llm.prompts import (
    SUMMARY_FIELDS,
    SUMMARY_PROMPT_VERSION,
    build_summary_messages,
)
from app.services.pdf.sections import Section

_CONTEXT_PRIORITY = [
    "abstract", "introduction", "method", "results", "conclusion",
    "experiments", "related_work", "other",
]
_MAX_CONTEXT_CHARS = 4_000
_LLM_RETRY_DELAY   = 10
_LLM_MAX_ATTEMPTS  = 2

@dataclass
class SummaryResult:
    fields:            dict[str, str]
    confidence_score:  float
    confidence_factors: dict
    prompt_version:    str
    raw:               dict

def _build_context(sections: list[Section]) -> str:
    by_type: dict[str, list[str]] = {}
    for sec in sections:
        by_type.setdefault(sec.section_type, []).append(sec.content)

    parts:  list[str] = []
    budget: int       = _MAX_CONTEXT_CHARS
    for stype in _CONTEXT_PRIORITY:
        for content in by_type.get(stype, []):
            if budget <= 0:
                break
            snippet = content[:budget]
            parts.append(f"[{stype}]\n{snippet}")
            budget -= len(snippet)
    return "\n\n".join(parts)

def _parse_json(raw_text: str) -> dict:
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1:
        text = text[start : end + 1]
    return json.loads(text)

def _confidence(parse_quality: float, section_coverage: float, fields_found: float) -> float:
    score = 0.4 * parse_quality + 0.3 * section_coverage + 0.3 * fields_found
    return round(max(0.0, min(1.0, score)), 2)

def _call_llm(messages: list[dict]) -> str:
    last_err: Exception | None = None
    for attempt in range(_LLM_MAX_ATTEMPTS):
        try:
            return chat(messages, response_json=False, max_tokens=800)
        except LLMError as exc:
            last_err = exc
            if attempt < _LLM_MAX_ATTEMPTS - 1:
                time.sleep(_LLM_RETRY_DELAY)
    raise last_err

def summarize(title: str, sections: list[Section], signals: dict) -> SummaryResult:
    context  = _build_context(sections)
    messages = build_summary_messages(title, context)
    raw_text = _call_llm(messages)

    try:
        parsed = _parse_json(raw_text)
    except (json.JSONDecodeError, ValueError):
        parsed = {}

    fields      = {f: str(parsed.get(f, "") or "").strip() for f in SUMMARY_FIELDS}
    fields_found = sum(1 for v in fields.values() if v) / len(SUMMARY_FIELDS)

    factors = {
        "parse_quality":    signals.get("parse_quality",    0.0),
        "section_coverage": signals.get("section_coverage", 0.0),
        "fields_found":     round(fields_found, 3),
    }
    score = _confidence(factors["parse_quality"], factors["section_coverage"], fields_found)

    return SummaryResult(
        fields=fields,
        confidence_score=score,
        confidence_factors=factors,
        prompt_version=SUMMARY_PROMPT_VERSION,
        raw={"model_output": raw_text},
    )
