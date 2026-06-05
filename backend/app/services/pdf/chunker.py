import re
from dataclasses import dataclass

from app.services.pdf.sections import Section

_CHARS_PER_TOKEN = 4
_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")

def estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)

@dataclass
class Chunk:
    section_type: str
    section_ordering: int
    chunk_index: int
    content: str
    token_count: int

def _split_units(text: str) -> list[str]:
    units: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if estimate_tokens(para) <= 1:
            continue
        units.append(para)
    return units

def chunk_sections(
    sections: list[Section],
    target_tokens: int = 500,
    overlap_tokens: int = 60,
) -> list[Chunk]:
    chunks: list[Chunk] = []
    global_index = 0

    for sec in sections:
        units = _split_units(sec.content)
        if not units:
            continue

        buffer: list[str] = []
        buffer_tokens = 0

        def flush() -> None:
            nonlocal buffer, buffer_tokens, global_index
            if not buffer:
                return
            content = "\n\n".join(buffer).strip()
            chunks.append(
                Chunk(
                    section_type=sec.section_type,
                    section_ordering=sec.ordering,
                    chunk_index=global_index,
                    content=content,
                    token_count=estimate_tokens(content),
                )
            )
            global_index += 1

        for unit in units:
            unit_tokens = estimate_tokens(unit)

            if unit_tokens > target_tokens:
                for sentence in _SENT_SPLIT.split(unit):
                    sentence = sentence.strip()
                    if not sentence:
                        continue
                    st = estimate_tokens(sentence)
                    if buffer_tokens + st > target_tokens and buffer:
                        flush()
                        buffer, buffer_tokens = [], 0
                    buffer.append(sentence)
                    buffer_tokens += st
                continue

            if buffer_tokens + unit_tokens > target_tokens and buffer:
                flush()
                if overlap_tokens > 0 and chunks:
                    tail = chunks[-1].content[-overlap_tokens * _CHARS_PER_TOKEN:]
                    buffer, buffer_tokens = [tail], estimate_tokens(tail)
                else:
                    buffer, buffer_tokens = [], 0

            buffer.append(unit)
            buffer_tokens += unit_tokens

        flush()

    return chunks
