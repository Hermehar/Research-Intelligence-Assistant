from dataclasses import dataclass, field

from app.services.pdf.chunker import Chunk, chunk_sections
from app.services.pdf.extractor import extract_text
from app.services.pdf.sections import Section, detect_sections, section_coverage

@dataclass
class PipelineResult:
    text: str
    page_count: int
    sections: list[Section]
    chunks: list[Chunk]
    signals: dict = field(default_factory=dict)

def process_pdf(pdf_bytes: bytes) -> PipelineResult:
    extraction = extract_text(pdf_bytes)
    sections = detect_sections(extraction.text)
    chunks = chunk_sections(sections)
    coverage = section_coverage(sections)

    return PipelineResult(
        text=extraction.text,
        page_count=extraction.page_count,
        sections=sections,
        chunks=chunks,
        signals={
            "parse_quality": extraction.parse_quality,
            "section_coverage": coverage,
            "char_count": extraction.char_count,
            "section_count": len(sections),
            "chunk_count": len(chunks),
        },
    )
