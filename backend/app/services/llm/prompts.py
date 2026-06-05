SUMMARY_PROMPT_VERSION = "summary.v1"

SUMMARY_FIELDS = [
    "research_problem",
    "motivation",
    "methodology",
    "dataset",
    "evaluation_metrics",
    "key_results",
    "novel_contributions",
    "limitations",
    "future_work",
]

_SYSTEM = (
    "You are a meticulous research assistant. You read scientific papers and "
    "produce faithful, concise structured summaries. You only state what the "
    "text supports. If a field is not addressed in the provided text, return an "
    "empty string for that field rather than guessing. You never invent datasets, "
    "metrics, or results."
)

def build_summary_messages(title: str, context: str) -> list[dict]:
    field_lines = "\n".join(f'  "{f}": ""' for f in SUMMARY_FIELDS)
    user = (
        f"Paper title: {title}\n\n"
        f"Paper text (may be truncated):\n\"\"\"\n{context}\n\"\"\"\n\n"
        "Return ONLY a JSON object with exactly these keys and string values:\n"
        "{\n"
        f"{field_lines}\n"
        "}\n"
        "Each value should be 1-3 sentences. Use an empty string for anything the "
        "text does not support. Do not add commentary or markdown fences."
    )
    return [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": user},
    ]
