import re
from dataclasses import dataclass

_SYNONYMS: dict[str, tuple[str, ...]] = {
    "abstract": ("abstract",),
    "introduction": ("introduction",),
    "related_work": ("related work", "background", "prior work", "literature review"),
    "method": ("method", "methods", "methodology", "approach", "proposed method",
               "our approach", "model", "architecture"),
    "experiments": ("experiment", "experiments", "experimental setup", "setup",
                    "implementation details", "experimental settings"),
    "results": ("results", "evaluation", "evaluations", "findings"),
    "conclusion": ("conclusion", "conclusions", "discussion", "future work",
                   "concluding remarks", "limitations"),
}
_TERMINAL = ("references", "bibliography", "acknowledgments", "acknowledgements", "appendix")

_NUM = r"(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.?)?"
_HEADING_RE = re.compile(rf"^\s*{_NUM}\s*(.+?)\s*$")

@dataclass
class Section:
    section_type: str
    heading: str | None
    content: str
    ordering: int

def _classify(heading_text: str) -> str | None:
    norm = re.sub(r"[^a-z ]", "", heading_text.lower()).strip()
    if not norm:
        return None
    for term in _TERMINAL:
        if norm == term or norm.startswith(term):
            return "__terminal__"
    for stype, keywords in _SYNONYMS.items():
        for kw in keywords:
            if norm == kw or norm.startswith(kw + " ") or norm.endswith(" " + kw):
                return stype
    return None

def _looks_like_heading(line: str) -> str | None:
    stripped = line.strip()
    if not stripped or len(stripped) > 60:
        return None
    if stripped.endswith("."):
        pass
    m = _HEADING_RE.match(stripped)
    if not m:
        return None
    return _classify(m.group(1))

def detect_sections(text: str) -> list[Section]:
    lines = text.splitlines()
    marks: list[tuple[int, str, str]] = []
    for i, line in enumerate(lines):
        stype = _looks_like_heading(line)
        if stype:
            marks.append((i, stype, line.strip()))

    sections: list[Section] = []
    ordering = 0

    if not marks:
        body = text.strip()
        if body:
            sections.append(Section("other", None, body, 0))
        return sections

    first_idx = marks[0][0]
    front = "\n".join(lines[:first_idx]).strip()
    if front:
        sections.append(Section("other", None, front, ordering))
        ordering += 1

    for j, (idx, stype, heading) in enumerate(marks):
        if stype == "__terminal__":
            break
        end = marks[j + 1][0] if j + 1 < len(marks) else len(lines)
        content = "\n".join(lines[idx + 1:end]).strip()
        sections.append(Section(stype, heading, content, ordering))
        ordering += 1

    return sections

EXPECTED_SECTIONS = ("abstract", "introduction", "method", "experiments", "results", "conclusion")

def section_coverage(sections: list[Section]) -> float:
    found = {s.section_type for s in sections}
    hits = sum(1 for s in EXPECTED_SECTIONS if s in found)
    return round(hits / len(EXPECTED_SECTIONS), 3)
