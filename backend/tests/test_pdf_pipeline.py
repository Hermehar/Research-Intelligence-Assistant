import fitz

from app.services.pdf.pipeline import process_pdf
from app.services.pdf.sections import detect_sections, section_coverage

_LOREM = (
    "This paragraph contains several sentences describing the work in detail. "
    "It explains the context and provides enough text for chunking to occur. "
    "We repeat informative content so the chunker has material to split. "
)

def _make_pdf() -> bytes:
    blocks = [
        ("Abstract", _LOREM * 3),
        ("1 Introduction", _LOREM * 4),
        ("2 Related Work", _LOREM * 2),
        ("3 Methodology", _LOREM * 4),
        ("4 Experiments", _LOREM * 3),
        ("5 Results", _LOREM * 3),
        ("6 Conclusion", _LOREM * 2),
        ("References", "[1] Someone et al. A paper. 2020."),
    ]
    doc = fitz.open()
    page = doc.new_page()
    y = 60
    for heading, body in blocks:
        if y > 740:
            page = doc.new_page()
            y = 60
        page.insert_text((50, y), heading, fontsize=13)
        y += 22
        for chunk_line in _wrap(body, 90):
            if y > 770:
                page = doc.new_page()
                y = 60
            page.insert_text((50, y), chunk_line, fontsize=10)
            y += 14
        y += 12
    data = doc.tobytes()
    doc.close()
    return data

def _wrap(text: str, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines

def test_sections_detected():
    pdf = _make_pdf()
    result = process_pdf(pdf)
    found = {s.section_type for s in result.sections}
    for expected in ("abstract", "introduction", "method", "experiments", "results", "conclusion"):
        assert expected in found, f"missing {expected}: {found}"
    assert all("[1]" not in (s.content or "") for s in result.sections)

def test_signals_reasonable():
    result = process_pdf(_make_pdf())
    assert result.signals["parse_quality"] > 0.0
    assert result.signals["section_coverage"] >= 0.8
    assert result.signals["chunk_count"] >= 1

def test_chunks_respect_sections():
    result = process_pdf(_make_pdf())
    assert result.chunks, "expected at least one chunk"
    valid = {s.ordering for s in result.sections}
    for c in result.chunks:
        assert c.section_ordering in valid

def test_no_headings_yields_single_section():
    secs = detect_sections("Just some plain text with no recognizable headings at all.")
    assert len(secs) == 1
    assert secs[0].section_type == "other"
    assert section_coverage(secs) == 0.0
