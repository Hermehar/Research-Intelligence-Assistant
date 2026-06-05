from dataclasses import dataclass

import fitz

@dataclass
class ExtractionResult:
    text: str
    page_count: int
    char_count: int
    parse_quality: float

def extract_text(pdf_bytes: bytes) -> ExtractionResult:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages = [page.get_text("text") for page in doc]
        page_count = doc.page_count
    finally:
        doc.close()

    text = "\n".join(pages).strip()
    char_count = len(text)

    if page_count == 0:
        quality = 0.0
    else:
        chars_per_page = char_count / page_count
        quality = max(0.0, min(1.0, chars_per_page / 800.0))

    return ExtractionResult(
        text=text,
        page_count=page_count,
        char_count=char_count,
        parse_quality=round(quality, 3),
    )
